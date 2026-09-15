# Scraper

TypeScript scraper for Riftbound events. Two sources are merged into one event set:

1. **UVS Games API** (`src/api.ts`) - the store locator behind https://locator.riftbound.uvsgames.com/
2. **playriftbound API** (`src/sources/playriftbound.ts`) - Riot's official event search

## Structure

```
src/
├── index.ts                    # Entry point, runs distributed scrape loop + second source
├── lambda.ts                   # Lambda entry point (burst mode), also runs both sources
├── config.ts                   # Zod-validated env config
├── database.ts                 # DB operations for events, shops, scrape_runs
├── dedupe.ts                   # Cross-source de-duplication key
├── api.ts                      # UVS Games API client (source 1)
└── sources/playriftbound.ts    # Riot playriftbound API client (source 2)
```

## How It Works

The scraper uses the UVS Games API with a **distributed scraping** approach:

1. **Get count** (`api.ts`): Single API call to get total event count and calculate pages needed
2. **Distributed fetching**: Spreads ~31 page requests evenly across the 60-minute cycle (~105s between requests)
3. **Upsert events** (`database.ts`): Inserts/updates events with coordinates from API
4. **Upsert stores**: Store info (with coordinates) embedded in each event response

This approach prevents burst traffic and maintains consistent, gentle load on the upstream API.

## API Endpoint

```
https://api.cloudflare.riftbound.uvsgames.com/hydraproxy/api/v2/events/
  ?start_date_after=<today>
  &start_date_before=<today+90days>
  &display_status=upcoming
  &latitude=0&longitude=0
  &num_miles=20000
  &upcoming_only=true
  &game_slug=riftbound
  &page=1
  &page_size=1000
```

Only fetches events within 90 days to match the calendar display range.

Returns JSON with:
- Event details (name, description, date/time, format, price, capacity)
- Coordinates (latitude, longitude)
- Full store info (name, address, coordinates, website, email)

## Second Source: playriftbound (`src/sources/playriftbound.ts`)

Riot's own event search, run once at the end of each cycle after the UVS pass.
It adds authoritative event types (straight from Riot's `tournamentType` enum
rather than inferred from the event name) and real registration URLs, which the
UVS source does not provide.

```
GET https://events.playriftbound.com/api/gql
  ?variables={"sport":"rb","first":100,"filter":{"rb":{"coords":{...},"distanceMeters":160000}},"sortBy":{"rb":"DATE"}}
  &extensions={"persistedQuery":{"version":1,"sha256Hash":"<hash>"}}
Headers: apollo-require-preflight, apollographql-client-name, apollographql-client-version
```

Three constraints shape this client:

### 1. Anchor-based coverage (there is no global query)

Every search is anchored on a coordinate, the distance filter is enforced server
side, and - this is the important part - **the server silently clamps the radius
to ~161km (100 miles)**. Asking for `distanceMeters: 5000000` around San
Francisco returns 428 events, the farthest of them 159km away, with
`hasNextPage: false`; a query from Chicago with the same 5,000km radius returns a
completely disjoint set of midwest events. A whole-world request (lat 0 / lon 0,
40,000km) returns zero edges. There is no equivalent of the UVS source's
`num_miles=20000` global query.

Coverage therefore comes from many anchors rather than a few:

- Anchors are derived from the coordinates the **UVS pass just collected**, one
  per geohash-3 cell (`anchorsFromCoordinates`). Precision-3 cells are ~156km
  square, so a query from the cell centre (at most ~110km from any corner) covers
  the whole cell - and coverage automatically tracks wherever Riftbound is
  actually played instead of a hand-maintained city list.
- `SEED_ANCHORS` (~48 global metros) is only a fallback for when no coordinates
  are available.
- Real data currently spans **1,000+ cells**, which is far more than is polite to
  query in one cycle, so each run sweeps a window of
  `PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN` anchors (`selectAnchorBatch`) that slides
  with the wall clock and wraps once a day. Using clock *position* rather than a
  run counter means no persisted state is needed (each production run is a fresh
  Lambda invocation) and the schedule can change without opening coverage gaps:
  as long as runs-per-day x anchors-per-run >= total anchors, consecutive windows
  overlap. The production 2-hourly schedule gives 12 x 150 = 1,800 anchor-slots a
  day for ~1,000 anchors.

Pagination uses `after: <pageInfo.endCursor>` while `pageInfo.hasNextPage`.
Results are date-ordered, so paging for an anchor stops once a page runs past the
90-day calendar horizon. Anchors that return nothing are normal.

### 2. Persisted query hash self-heal

The API only accepts persisted queries (`PERSISTED_QUERY_ID_REQUIRED` otherwise),
and the `sha256Hash` for `CompeteTournamentSearch` rotates on every Riot deploy.
The scraper ships with a known-good hash and, on `PERSISTED_QUERY_NOT_IN_LIST`:

1. Re-reads Riot's public persisted-query manifest chunk and regex-extracts the
   current id for `CompeteTournamentSearch`.
2. If that chunk filename has itself rotated (404), fetches the events page HTML,
   collects the `_next/static/chunks/*.js` URLs it references, and probes them
   (plus chunk names referenced from inside them, which is where the webpack
   runtime names the lazily-loaded manifest chunk).
3. Caches the new hash for the process lifetime, retries once, and logs loudly.

If no hash can be resolved the source logs an error and returns zero events -
the UVS source still completes. `PLAYRIFTBOUND_QUERY_HASH` can pin a hash
manually as an escape hatch.

### 3. Polite rate limiting

This is Riot's production API and riftfound is a guest on it. Every request is
spaced by `PLAYRIFTBOUND_REQUEST_DELAY_MS` (default 1000ms, ~1 req/sec) with a
longer pause between anchors, and the rotating batch caps a run at ~150 anchors
(~3 minutes of requests). In Lambda the pass also takes a `deadline` and stops
early rather than eating the invocation's time budget; unswept anchors simply
roll over to the next run.

## De-duplication

The two sources share no identifier, so events are matched on location + time
(`src/dedupe.ts`):

```
round(latitude, 3) | round(longitude, 3) | start time truncated to the minute
```

3 decimal places is ~110m: tight enough to keep neighbouring stores apart, loose
enough to absorb the two APIs' different geocoders. Lookups also check the eight
neighbouring cells, because a store the two APIs geocode ~20m apart can still
land either side of a rounding boundary. Measured on ~700 UVS and ~430
playriftbound events around San Francisco, that lifts duplicate detection from 42
to 50 of the 50 true duplicates, while **no** two different stores in the sample
ran events within 250m of each other at the same minute - so the wider match does
not swallow distinct events.

The key set is built during the UVS pass only; colliding playriftbound events are
skipped and counted. playriftbound events are never de-duplicated against each
other - one store legitimately runs two different tournaments at the same minute,
and Riot's tournament ids already keep those apart.

playriftbound events are stored with a `prb-` prefix on `external_id` so they can
never collide with UVS numeric ids, and their organizers are stored as shops with
a synthesised numeric `external_id` (FNV-1a hash of Riot's organizer UUID, offset
into a reserved range).

Because anchors are swept in rotating batches, a playriftbound event missing from
one run's "seen" set is expected rather than cancelled, so `prb-` events are
always excluded from the daily stale-event cleanup and are aged out by
`deleteOldEvents` / the DynamoDB TTL instead.

## Environment

- `SCRAPE_INTERVAL_MINUTES`: Cycle length (default: 60). Requests distributed evenly across cycle.
- `DB_TYPE`: `sqlite` or `postgres`
- `PLAYRIFTBOUND_ENABLED`: Enable the second source (default: `true`)
- `PLAYRIFTBOUND_REQUEST_DELAY_MS`: Delay between playriftbound requests (default: `1000`)
- `PLAYRIFTBOUND_MAX_ANCHORS_PER_RUN`: Anchors swept per run (default: `150`)
- `PLAYRIFTBOUND_QUERY_HASH`: Pin the persisted query hash (optional, normally self-healing)

## Tests

```bash
npm test --workspace=scraper   # vitest
```
