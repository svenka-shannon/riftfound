import { describe, it, expect } from 'vitest';
import { dedupeKeyCandidates, eventDedupeKey, splitDuplicates } from '../dedupe.js';

describe('eventDedupeKey', () => {
  it('builds a lat|lon|minute key', () => {
    expect(
      eventDedupeKey({
        latitude: 37.020373,
        longitude: -121.56048120000001,
        startDate: new Date('2026-10-02T01:00:00Z'),
      })
    ).toBe('37.020|-121.560|2026-10-02T01:00Z');
  });

  it('matches the same event reported by two sources with slightly different coords', () => {
    // Same store, geocoded independently by UVS and by Riot (~20m apart)
    const uvs = eventDedupeKey({
      latitude: 38.0162814,
      longitude: -121.816311,
      startDate: new Date('2026-10-02T01:00:00.000Z'),
    });
    const riot = eventDedupeKey({
      latitude: 38.0162901,
      longitude: -121.8163045,
      startDate: new Date('2026-10-02T01:00:00Z'),
    });
    expect(riot).toBe(uvs);
  });

  it('ignores sub-minute differences in start time', () => {
    const a = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T01:00:59Z') });
    expect(b).toBe(a);
  });

  it('separates events at the same place at different times', () => {
    const a = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('2026-10-02T02:00:00Z') });
    expect(b).not.toBe(a);
  });

  it('separates events at the same time in different places', () => {
    const a = eventDedupeKey({ latitude: 37.7749, longitude: -122.4194, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 40.7128, longitude: -74.006, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(b).not.toBe(a);
  });

  it('separates stores more than ~110m apart', () => {
    const a = eventDedupeKey({ latitude: 37.0203, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') });
    const b = eventDedupeKey({ latitude: 37.0225, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(b).not.toBe(a);
  });

  it('normalises -0 and handles missing coordinates', () => {
    expect(eventDedupeKey({ latitude: -0.0001, longitude: 0, startDate: new Date('2026-10-02T01:00:00Z') })).toBe(
      '0.000|0.000|2026-10-02T01:00Z'
    );
    expect(eventDedupeKey({ latitude: null, longitude: undefined, startDate: new Date('2026-10-02T01:00:00Z') })).toBe(
      'na|na|2026-10-02T01:00Z'
    );
  });

  it('does not throw on an invalid date', () => {
    expect(eventDedupeKey({ latitude: 1, longitude: 2, startDate: new Date('nope') })).toBe('1.000|2.000|na');
  });
});

describe('splitDuplicates', () => {
  const uvsEvent = { latitude: 37.020373, longitude: -121.56048, startDate: new Date('2026-10-02T00:00:00Z') };

  // Riot event at the same store, same minute, from the second source
  const riotSameEvent = { id: 'a', latitude: 37.0203, longitude: -121.5605, startDate: new Date('2026-10-02T00:00:00Z') };
  const riotOtherEvent = { id: 'b', latitude: 40.7128, longitude: -74.006, startDate: new Date('2026-10-05T23:00:00Z') };

  it('drops second-source events the first source already reported', () => {
    const keys = new Set([eventDedupeKey(uvsEvent)]);
    const { unique, duplicates } = splitDuplicates([riotSameEvent, riotOtherEvent], keys);
    expect(unique.map(e => e.id)).toEqual(['b']);
    expect(duplicates.map(e => e.id)).toEqual(['a']);
  });

  it('keeps everything when the first source found nothing there', () => {
    const { unique, duplicates } = splitDuplicates([riotSameEvent, riotOtherEvent], new Set<string>());
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it('keeps two different tournaments at the same store and minute', () => {
    // Real case: "Games of Brentwood" runs two Pre-Rift events at 2026-10-19T01:00Z.
    // Only overlap with the *other* source counts as a duplicate, so both survive.
    const first = { id: 'prb-117096731805661097', latitude: 37.9419, longitude: -121.7367, startDate: new Date('2026-10-19T01:00:00Z') };
    const second = { id: 'prb-117124556273536574', latitude: 37.9419, longitude: -121.7367, startDate: new Date('2026-10-19T01:00:00Z') };
    expect(eventDedupeKey(first)).toBe(eventDedupeKey(second));

    const { unique, duplicates } = splitDuplicates([first, second], new Set<string>());
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });
});

describe('dedupeKeyCandidates', () => {
  it('returns the event cell plus its eight neighbours', () => {
    const event = { latitude: 37.0205, longitude: -121.5605, startDate: new Date('2026-10-02T01:00:00Z') };
    const keys = dedupeKeyCandidates(event);
    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(9);
    expect(keys).toContain(eventDedupeKey(event));
    // Base cell is 37.021|-121.560; neighbours step +/-0.001 on each axis
    expect(eventDedupeKey(event)).toBe('37.021|-121.560|2026-10-02T01:00Z');
    expect(keys).toContain('37.020|-121.561|2026-10-02T01:00Z');
    expect(keys).toContain('37.022|-121.559|2026-10-02T01:00Z');
  });

  it('wraps longitudes across the antimeridian', () => {
    const keys = dedupeKeyCandidates({ latitude: 0, longitude: 180, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(keys).toContain('0.000|-179.999|2026-10-02T01:00Z');
  });

  it('keeps missing coordinates unmatched', () => {
    const keys = dedupeKeyCandidates({ latitude: null, longitude: null, startDate: new Date('2026-10-02T01:00:00Z') });
    expect(new Set(keys)).toEqual(new Set(['na|na|2026-10-02T01:00Z']));
  });

  it('matches a store the two APIs geocoded either side of a rounding boundary', () => {
    // Real shape of the near-misses: ~20m apart, but 37.0205 rounds to 37.021
    // and 37.02049 rounds to 37.020.
    const uvs = { latitude: 37.02049, longitude: -121.56049, startDate: new Date('2026-10-02T01:00:00Z') };
    const riot = { latitude: 37.02051, longitude: -121.56051, startDate: new Date('2026-10-02T01:00:00Z') };
    expect(eventDedupeKey(riot)).not.toBe(eventDedupeKey(uvs));

    const { duplicates } = splitDuplicates([riot], new Set([eventDedupeKey(uvs)]));
    expect(duplicates).toHaveLength(1);
  });

  it('still separates stores more than ~250m apart', () => {
    const a = { latitude: 37.0203, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') };
    const b = { latitude: 37.0253, longitude: -121.5604, startDate: new Date('2026-10-02T01:00:00Z') };
    const { unique, duplicates } = splitDuplicates([b], new Set([eventDedupeKey(a)]));
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
  });
});
