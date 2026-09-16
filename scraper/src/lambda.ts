/**
 * AWS Lambda handler for the Riftfound Scraper
 *
 * This handler is triggered by EventBridge (CloudWatch Events) on a schedule
 * to scrape events from the Riftbound API and store them in DynamoDB.
 *
 * Unlike the continuous scraper that runs on EC2, this Lambda version runs
 * as a single burst operation - it fetches all pages as quickly as possible
 * since Lambda has a 15-minute timeout limit.
 */

import type { ScheduledEvent, Context } from 'aws-lambda';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  startScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertEventWithStore,
  updateShopDisplayCity,
  deleteOldEvents,
  shouldRunStaleCleanup,
  cleanupStaleEvents,
  UpsertShopResult,
} from './database.js';
import { fetchEventsPage, fetchEventTemplates, getEventCount, type UvsEvent } from './api.js';
import { fetchPlayriftboundEvents, PLAYRIFTBOUND_ID_PREFIX } from './sources/playriftbound.js';
import { addToDedupeIndex, markEventSeen, splitDuplicates, type DedupeIndex } from './dedupe.js';
import { mergeEventRecords } from './merge.js';
import { env } from './config.js';
import { reverseGeocodeCity } from './geocoding.js';

const cloudwatch = new CloudWatchClient({});

async function publishMetrics(metrics: {
  found: number;
  created: number;
  updated: number;
  skipped: number;
  skipRate: number;
  durationMs: number;
}): Promise<void> {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Riftfound/Scraper',
      MetricData: [
        { MetricName: 'EventsFound', Value: metrics.found, Unit: 'Count' },
        { MetricName: 'EventsCreated', Value: metrics.created, Unit: 'Count' },
        { MetricName: 'EventsUpdated', Value: metrics.updated, Unit: 'Count' },
        { MetricName: 'EventsSkipped', Value: metrics.skipped, Unit: 'Count' },
        { MetricName: 'SkipRate', Value: metrics.skipRate, Unit: 'Percent' },
        { MetricName: 'DurationMs', Value: metrics.durationMs, Unit: 'Milliseconds' },
      ],
    }));
  } catch (error) {
    console.error('Failed to publish CloudWatch metrics:', error);
  }
}

/**
 * Lambda handler for scheduled scraping
 */
export async function handler(
  event: ScheduledEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> {
  console.log('Lambda scraper invoked');
  console.log('Event:', JSON.stringify(event, null, 2));
  console.log('Remaining time:', context.getRemainingTimeInMillis(), 'ms');

  const startTime = Date.now();
  const runId = await startScrapeRun();

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;  // Events unchanged, write skipped (DynamoDB cost savings)
  let totalDuplicateIds = 0;  // Same event id returned twice by the API's unstable paging
  let totalStores = 0;
  let totalCitiesGeocoded = 0;
  const storesSeen = new Set<string>();
  const eventIdsSeen = new Set<string>();
  const shopsToGeocode: UpsertShopResult[] = [];

  // Second source (playriftbound) state - see runDistributedScrape in index.ts
  const uvsIndex: DedupeIndex<UvsEvent> = new Map();
  const uvsCoordinates: { latitude?: number | null; longitude?: number | null }[] = [];
  let prbFound = 0;
  let prbMerged = 0;
  let prbMergeWritten = 0;
  let prbMergeSkipped = 0;
  let prbAnchorsQueried = 0;
  let prbAnchorsAvailable = 0;

  try {
    // Fetch event configuration templates for category mapping
    await fetchEventTemplates();

    // Get total count to know how many pages we need
    const { total: totalExpected, pageCount } = await getEventCount();
    console.log(`API reports ${totalExpected} upcoming events (~${pageCount} pages)`);

    if (pageCount === 0) {
      console.log('No events to scrape');
      await completeScrapeRun(runId, {
        eventsFound: 0,
        eventsCreated: 0,
        eventsUpdated: 0,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No events to scrape', found: 0, created: 0 }),
      };
    }

    // Fetch all pages (burst mode - faster for Lambda)
    let currentPage = 1;
    while (true) {
      // Check remaining time - leave 60 seconds buffer for cleanup
      if (context.getRemainingTimeInMillis() < 60000) {
        console.warn('Running low on time, stopping early');
        break;
      }

      console.log(`Fetching page ${currentPage}/${pageCount}...`);
      const { events, hasMore } = await fetchEventsPage(currentPage);

      // Process events from this page
      for (const event of events) {
        // Offset pagination is unstable upstream, so the same event id shows up
        // on more than one page within a run (~1.5% of rows). Skip the repeats
        // instead of upserting them twice.
        if (!markEventSeen(eventIdsSeen, event.externalId)) {
          totalDuplicateIds++;
          continue;
        }

        totalFound++;
        addToDedupeIndex(uvsIndex, event);
        uvsCoordinates.push({ latitude: event.latitude, longitude: event.longitude });
        const result = await upsertEventWithStore(event, event.storeInfo);
        if (result.created) {
          totalCreated++;
        } else if (result.skipped) {
          totalSkipped++;
        } else {
          totalUpdated++;
        }

        // Track unique stores
        if (event.storeInfo && !storesSeen.has(event.storeInfo.name)) {
          storesSeen.add(event.storeInfo.name);
          totalStores++;

          if (result.shopResult?.needsCityGeocode) {
            shopsToGeocode.push(result.shopResult);
          }
        }
      }

      const skipInfo = totalSkipped > 0 ? `, ${totalSkipped} unchanged` : '';
      console.log(`Page ${currentPage}: ${events.length} events (${totalCreated} new, ${totalUpdated} updated${skipInfo})`);

      if (!hasMore) {
        break;
      }

      currentPage++;

      // Small delay to be respectful to upstream API (2 seconds)
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Second source: Riot's playriftbound API. Rate limited, so it only runs
    // with whatever time is left after the UVS burst and stops at its deadline -
    // unswept anchors roll over to the next invocation.
    const PRB_RESERVED_MS = 120000; // leave time for geocoding + cleanup + metrics
    if (env.PLAYRIFTBOUND_ENABLED && context.getRemainingTimeInMillis() > PRB_RESERVED_MS + 30000) {
      console.log('Running playriftbound source...');
      const prbResult = await fetchPlayriftboundEvents({
        requestDelayMs: env.PLAYRIFTBOUND_REQUEST_DELAY_MS,
        maxAnchorsPerRun: env.PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN,
        queryHash: env.PLAYRIFTBOUND_QUERY_HASH,
        coordinates: uvsCoordinates,
        deadline: Date.now() + context.getRemainingTimeInMillis() - PRB_RESERVED_MS,
      });

      prbAnchorsQueried = prbResult.anchorsQueried;
      prbAnchorsAvailable = prbResult.anchorsAvailable;

      const { unique: prbUnique, matched: prbMatched } = splitDuplicates(prbResult.events, uvsIndex);
      prbMerged = prbMatched.length;

      // Matched pairs are field-merged onto the incumbent UVS record and
      // re-upserted under the UVS externalId (no duplicate row) instead of the
      // Riot record being discarded. See merge.ts for the field policy.
      for (const { secondary, primary } of prbMatched) {
        const merged = mergeEventRecords(primary, secondary);
        const mergeResult = await upsertEventWithStore(merged, merged.storeInfo);
        if (mergeResult.skipped) {
          prbMergeSkipped++;
        } else {
          prbMergeWritten++;
        }
      }

      for (const event of prbUnique) {
        if (!markEventSeen(eventIdsSeen, event.externalId)) {
          totalDuplicateIds++;
          continue;
        }
        prbFound++;
        totalFound++;
        const result = await upsertEventWithStore(event, event.storeInfo);
        if (result.created) {
          totalCreated++;
        } else if (result.skipped) {
          totalSkipped++;
        } else {
          totalUpdated++;
        }

        if (event.storeInfo && !storesSeen.has(event.storeInfo.name)) {
          storesSeen.add(event.storeInfo.name);
          totalStores++;

          if (result.shopResult?.needsCityGeocode) {
            shopsToGeocode.push(result.shopResult);
          }
        }
      }

      console.log(
        `playriftbound: ${prbFound} events upserted, ${prbMerged} field-merged into matching UVS events ` +
          `(${prbMergeWritten} rewritten, ${prbMergeSkipped} already up to date), ` +
          `${prbAnchorsQueried}/${prbAnchorsAvailable} anchors swept`
      );
    } else if (env.PLAYRIFTBOUND_ENABLED) {
      console.warn('Skipping playriftbound source - not enough Lambda time remaining');
    }

    // Process shops that need city geocoding (if we have time)
    if (shopsToGeocode.length > 0 && context.getRemainingTimeInMillis() > 30000) {
      console.log(`Geocoding cities for ${shopsToGeocode.length} shops...`);
      for (const shop of shopsToGeocode) {
        if (context.getRemainingTimeInMillis() < 15000) {
          console.warn('Skipping remaining geocoding - low time');
          break;
        }
        try {
          const city = await reverseGeocodeCity(shop.latitude, shop.longitude);
          if (city) {
            updateShopDisplayCity(shop.shopId, city);
            totalCitiesGeocoded++;
          }
        } catch (error) {
          console.error(`Failed to geocode shop ${shop.shopId}:`, error);
        }
      }
    }

    // Complete the scrape run
    await completeScrapeRun(runId, {
      eventsFound: totalFound,
      eventsCreated: totalCreated,
      eventsUpdated: totalUpdated,
    });

    // Clean up old events if we have time
    let deletedCount = 0;
    if (context.getRemainingTimeInMillis() > 15000) {
      deletedCount = await deleteOldEvents(60);
    }

    // Once per day, remove upcoming events that disappeared from the API (cancelled/removed)
    let staleCount = 0;
    if (eventIdsSeen.size > 0 && context.getRemainingTimeInMillis() > 30000) {
      const shouldCleanup = await shouldRunStaleCleanup();
      if (shouldCleanup) {
        console.log(`Running stale event cleanup (${eventIdsSeen.size} events seen in API)...`);
        // playriftbound anchors are swept in rotating batches, so its events are
        // expected to be missing from a single run's seen set - never stale.
        staleCount = await cleanupStaleEvents(eventIdsSeen, [PLAYRIFTBOUND_ID_PREFIX]);
        if (staleCount > 0) {
          console.log(`Removed ${staleCount} stale events no longer in API`);
        } else {
          console.log('No stale events found');
        }
      }
    }

    const skipRate = totalFound > 0 ? Math.round((totalSkipped / totalFound) * 100) : 0;
    const durationMs = Date.now() - startTime;
    const summary = {
      message: 'Scrape completed',
      found: totalFound,
      created: totalCreated,
      updated: totalUpdated,
      skipped: totalSkipped,
      skipRate: `${skipRate}%`,
      stores: totalStores,
      duplicateIdsSkipped: totalDuplicateIds,
      playriftboundFound: prbFound,
      playriftboundMerged: prbMerged,
      playriftboundAnchors: `${prbAnchorsQueried}/${prbAnchorsAvailable}`,
      citiesGeocoded: totalCitiesGeocoded,
      pagesProcessed: currentPage,
      deleted: deletedCount,
      staleRemoved: staleCount,
      durationMs,
    };

    console.log('Scrape summary:', summary);

    // Publish metrics to CloudWatch
    await publishMetrics({
      found: totalFound,
      created: totalCreated,
      updated: totalUpdated,
      skipped: totalSkipped,
      skipRate,
      durationMs,
    });

    return {
      statusCode: 200,
      body: JSON.stringify(summary),
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Scrape failed:', message);

    await failScrapeRun(runId, message);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: message }),
    };
  }
}
