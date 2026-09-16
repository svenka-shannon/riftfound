import type { ScrapedEvent } from './database.js';

/**
 * Field-level merge of the same real-world event as reported by both sources.
 *
 * When the UVS Games row and the playriftbound row are judged to be the same
 * event (see dedupe.ts), neither record is thrown away: the UVS row stays the
 * row of record - same `externalId`, so no duplicate row is created - and the
 * fields Riot is authoritative about are written over it.
 *
 * The policy below is what the audit of both live feeds measured:
 *
 * - `eventType`  -> Riot. Riot returns a real `tournamentType` enum; the UVS
 *                   category is inferred from the event name and was wrong ~27%
 *                   of the time outside prerelease week (82.8% accurate overall).
 *                   Riot's generic `Other` fallback does *not* overwrite a more
 *                   specific UVS category - that is a missing value, not a
 *                   better one.
 * - `url`        -> Riot. UVS has no event URL on any row; Riot has one on 100%.
 * - `playerCount`-> UVS. Riot returns an empty `registrantCounts` for ~70% of
 *                   events, so its count is null 72% of the time. Riot's value
 *                   is only used when UVS has none.
 * - `description`,
 *   `imageUrl`,
 *   `endDate`    -> UVS. Riot's search API exposes none of the three.
 * - `capacity`,
 *   `price`      -> UVS unless null. UVS is the incumbent; preferring it avoids
 *                   rewriting rows every run for cosmetic differences.
 * - `name`, `organizer`, `location`, `address`, city/state/country, coordinates,
 *   `startDate`, `startTime`, `storeInfo` -> UVS, untouched. These drive the
 *   shop row and the map, and churning them every run would rewrite the whole
 *   table for no user-visible gain.
 *
 * The merged record records which sources contributed in `sources`, so the
 * origin of a row is inspectable in the database rather than guessable.
 */

export const SOURCE_UVS = 'uvs';
export const SOURCE_PLAYRIFTBOUND = 'playriftbound';

/** Category both sources emit when they cannot classify an event. */
const UNCLASSIFIED_EVENT_TYPE = 'other';

function isClassified(eventType: string | null | undefined): boolean {
  const value = eventType?.trim().toLowerCase();
  return !!value && value !== UNCLASSIFIED_EVENT_TYPE;
}

/**
 * Riot's enum wins, unless Riot could not classify the event at all - then the
 * UVS name-inferred category is better than nothing.
 */
export function mergeEventType(
  uvsEventType: string | null | undefined,
  playriftboundEventType: string | null | undefined
): string | null {
  if (isClassified(playriftboundEventType)) return playriftboundEventType ?? null;
  if (isClassified(uvsEventType)) return uvsEventType ?? null;
  return playriftboundEventType ?? uvsEventType ?? null;
}

/** Union of the contributing source labels, order-stable and de-duplicated. */
export function mergeSources(
  ...sourceLists: (readonly string[] | null | undefined)[]
): string[] {
  const merged: string[] = [];
  for (const list of sourceLists) {
    for (const source of list ?? []) {
      if (source && !merged.includes(source)) merged.push(source);
    }
  }
  return merged;
}

/**
 * Merge a playriftbound event into the UVS event it duplicates.
 *
 * The result keeps the UVS identity (`externalId`, coordinates, store), so it
 * upserts over the existing UVS row instead of creating a second one.
 */
export function mergeEventRecords<U extends ScrapedEvent, P extends ScrapedEvent>(
  uvsEvent: U,
  playriftboundEvent: P
): U {
  return {
    ...uvsEvent,

    // Riot is authoritative.
    eventType: mergeEventType(uvsEvent.eventType, playriftboundEvent.eventType),
    url: playriftboundEvent.url ?? uvsEvent.url ?? null,

    // UVS wins, Riot only fills the gaps.
    playerCount: uvsEvent.playerCount ?? playriftboundEvent.playerCount ?? null,
    capacity: uvsEvent.capacity ?? playriftboundEvent.capacity ?? null,
    price: uvsEvent.price ?? playriftboundEvent.price ?? null,
    description: uvsEvent.description ?? playriftboundEvent.description ?? null,
    imageUrl: uvsEvent.imageUrl ?? playriftboundEvent.imageUrl ?? null,
    endDate: uvsEvent.endDate ?? playriftboundEvent.endDate ?? null,

    sources: mergeSources(uvsEvent.sources ?? [SOURCE_UVS], playriftboundEvent.sources ?? [SOURCE_PLAYRIFTBOUND]),
  };
}
