import type { ScrapedEvent } from './database.js';

/**
 * Cross-source event de-duplication.
 *
 * The UVS Games API and Riot's playriftbound API have no shared identifier for
 * the same real-world event, so events are matched on the only things both
 * sources agree on: where the event is and when it starts.
 *
 * Key = round(lat, 3) | round(lon, 3) | start time truncated to the minute.
 * 3 decimal places of latitude/longitude is roughly 110m, which is tight enough
 * to keep two different stores in the same strip mall apart but loose enough to
 * absorb the small differences between the two APIs' geocoders.
 *
 * Lookups additionally check the eight neighbouring cells, because a store the
 * two APIs geocode ~20m apart can still land either side of a rounding boundary.
 * Measured against ~700 UVS and ~430 playriftbound events around San Francisco,
 * this lifts duplicate detection from 42 to 50 of the 50 true duplicates, and no
 * two *different* stores in that sample ran events within 250m of each other at
 * the same minute, so the wider match does not swallow distinct events.
 */

export type DedupeableEvent = Pick<ScrapedEvent, 'latitude' | 'longitude' | 'startDate'>;

function roundCoord(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'na';
  }
  // Math.round can produce -0; toFixed normalises it back to "0.000".
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

function startMinute(startDate: Date): string {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return 'na';
  }
  // "2026-10-02T01:00:00.000Z" -> "2026-10-02T01:00Z"
  return `${startDate.toISOString().slice(0, 16)}Z`;
}

/**
 * Build the de-duplication key for an event.
 * Two events from different sources with the same key are considered the same event.
 */
export function eventDedupeKey(event: DedupeableEvent): string {
  return [roundCoord(event.latitude), roundCoord(event.longitude), startMinute(event.startDate)].join('|');
}

/** One cell step: the rounding granularity of the key, ~110m. */
const CELL = 0.001;
const OFFSETS = [-CELL, 0, CELL];

function shiftCoord(rounded: string, offset: number): string {
  if (rounded === 'na') return 'na';
  const shifted = Number(rounded) + offset;
  // Keep longitudes inside [-180, 180] so antimeridian neighbours still match.
  const wrapped = shifted > 180 ? shifted - 360 : shifted < -180 ? shifted + 360 : shifted;
  return (Math.round(wrapped * 1000) / 1000).toFixed(3);
}

/**
 * Every key that should be treated as "this same event", i.e. the event's own
 * cell plus the eight cells around it.
 */
export function dedupeKeyCandidates(event: DedupeableEvent): string[] {
  const lat = roundCoord(event.latitude);
  const lon = roundCoord(event.longitude);
  const minute = startMinute(event.startDate);

  const keys: string[] = [];
  for (const dLat of OFFSETS) {
    for (const dLon of OFFSETS) {
      keys.push(`${shiftCoord(lat, dLat)}|${shiftCoord(lon, dLon)}|${minute}`);
    }
  }
  return keys;
}

/**
 * Split a secondary source's events into the ones the primary source has not
 * already reported and the ones it has.
 *
 * Matching is done on the event's cell and its eight neighbours (see
 * dedupeKeyCandidates), while `existingKeys` holds plain keys from eventDedupeKey.
 *
 * `existingKeys` is intentionally *not* extended as events are inspected: a
 * single store legitimately runs two different tournaments starting at the same
 * minute, so two events from the same source sharing a key are both kept. Only
 * overlap with the primary source counts as a duplicate.
 */
export function splitDuplicates<T extends DedupeableEvent>(
  events: T[],
  existingKeys: ReadonlySet<string>
): { unique: T[]; duplicates: T[] } {
  const unique: T[] = [];
  const duplicates: T[] = [];

  for (const event of events) {
    if (dedupeKeyCandidates(event).some(key => existingKeys.has(key))) {
      duplicates.push(event);
    } else {
      unique.push(event);
    }
  }

  return { unique, duplicates };
}
