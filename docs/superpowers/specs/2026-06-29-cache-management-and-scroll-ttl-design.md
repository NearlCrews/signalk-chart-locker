# Cache management and scroll-tile TTL design (2026-06-29)

Status: design, reviewed, pending user approval.

## Summary

Add two related capabilities to the shared boat-wide tile cache:

1. A scroll-tile TTL: an age-based reclaim that evicts unpinned scroll tiles whose last access is
   older than a configured number of days, even when the cache is under its size cap. Pinned tiles
   (saved regions and position-warm) are never aged out. This fills the gap that the existing
   LRU-at-cap eviction leaves: a cache that never reaches the cap holds months-old browsing forever.
2. A cache-management section in the regions panel: a breakdown of what the cache holds (total used
   against the cap, and per-source rows), a control to set the TTL days, and a button to clear the
   scroll cache on demand.

The existing freshness behavior is unchanged. The read path in `fetcher.rs` `get_tile` already
serves a cached tile and stale-revalidates it when it is past the freshness window, so the TTL here
is purely a space-reclaim policy, not a re-fetch policy.

## Goals

- Reclaim disk by aging out unpinned scroll tiles not viewed within the TTL window.
- Never evict a pinned tile (region or position-warm) through either the age sweep or the manual
  clear.
- Give the user a clear view of cache contents and two actions: set the TTL, and clear the scroll
  cache now.
- Keep the container egress-isolated and Signal K agnostic. All new state and policy live behind the
  same plugin-to-container seam the regions feature already uses, reusing the existing `/config`
  push, not a new one.

## Non-goals (YAGNI)

- No freshness or forced re-fetch policy. The `fetcher.rs` `get_tile` stale-revalidate path covers
  staleness on read.
- No per-source clear buttons, no per-tile management, no cache browser map overlay.
- No region management here. Saved regions keep their existing re-download and delete in the regions
  list.
- No scheduled region refresh (a separate deferred sub-project).

## Decisions (from brainstorming and review)

- TTL job: age-based reclaim of unpinned scroll tiles by `last_access`. Pinned exempt.
- Sweep cadence: one sweep at container startup, then a low-frequency timer. Both are one tokio
  interval whose immediate first tick is the startup sweep.
- UI scope: breakdown, a clear-scroll button, and the TTL-days control, in a new regions-panel
  section.
- Clear semantics: clear wipes all unpinned scroll tiles immediately, regardless of age. Pinned
  untouched. Behind an inline confirm.
- TTL persistence: `cacheScrollTtlDays` lives in the regions-store (the same panel-edited JSON store
  that holds position-warm settings), not in `schema()`. The plugin config screen
  (`schema()`) deliberately stays a separate input surface, so the TTL is panel-edited only and never
  appears twice.

## Architecture

Three layers, each extending an existing seam.

### Rust container (`container/tilecache`)

1. Live TTL field. Add `live_scroll_ttl_secs` to the cache state in `state.rs`, next to
   `live_cap_bytes`, `live_regions_budget`, and `live_position_warm_budget`. Zero means the TTL is
   disabled (LRU-at-cap only). It is seeded at construction from an env variable (below) and updated
   when the plugin posts a new value through `/config`.
2. Env seed for the startup sweep. `main.rs` reads a new `TILECACHE_SCROLL_TTL_SECS` env variable
   (mirroring `TILECACHE_CAP_BYTES`) and passes it into `AppState::new`, so `live_scroll_ttl_secs` is
   set before the tokio sweep task's first tick. The plugin sets this env from the store value when it
   launches the container, exactly as it sets the cap env. Without this seed the startup sweep would
   race the plugin's first `/config` push and run as a no-op on cold boot.
3. Start `/config` field and a dedicated live route. Add `scroll_ttl_secs: Option<i64>` to the
   existing `ConfigBody` and set `live_scroll_ttl_secs` in the `config()` handler, alongside the cap
   and budget fields, so the start `/config` push carries the TTL with no extra round-trip. For a live
   TTL edit, add a dedicated `POST /cache/scroll-ttl { ttlSecs }` route that sets only
   `live_scroll_ttl_secs`. The live edit cannot re-post `/config`, because `/config`'s `sources` is
   required and replaces the allowlist while also clearing the learned style state, so a partial
   `/config` would wipe the allowlist; the dedicated route avoids that churn. Start uses `/config`,
   the live edit uses the dedicated route.
4. Age sweep. A new function in `cache.rs` that deletes rows where `pinned = 0` and
   `last_access < (now - ttl)`, a no-op when the TTL is zero. It shares only the `pinned = 0` guard
   with the existing windowed LRU eviction (`evict_unpinned_within`); the predicate and delete shape
   are otherwise its own (age cutoff, not a size target). It deletes in bounded chunks using
   `DELETE FROM tiles WHERE rowid IN (SELECT rowid FROM tiles WHERE pinned = 0 AND last_access < ?1
   LIMIT ?2)` in a loop, releasing the cache lock between chunks, because the build does not enable
   `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` (so a plain `DELETE ... LIMIT` will not compile) and because a
   single large delete under the one global connection mutex would stall tile serving. It decrements
   `inner.total_bytes` by the freed bytes under the same lock and leaves `inner.pinned_bytes`
   unchanged, and returns the freed bytes and row count.
5. Clear scroll. A new function in `cache.rs` that deletes all rows where `pinned = 0`, in the same
   bounded-chunk form. It sets `inner.total_bytes` to `inner.pinned_bytes` (everything left is
   pinned), leaves `pinned_bytes` unchanged, and returns the freed bytes and rows.
6. Sweep scheduler. A tokio interval task started with the container. The interval fires immediately
   (that first tick is the startup sweep) and then on a fixed period (default hourly, a build-time
   constant; the user controls the TTL window, not the sweep frequency), with
   `MissedTickBehavior::Skip` so a slow tick never double-fires. The task body never unwraps a sweep
   result: on an error it logs and continues, so a transient SQLite error can never end the interval
   or wedge the TTL until restart. The period must stay well above the touch throttle (last_access
   updates are throttled to once an hour), so the minimum TTL is one day, never sub-day.
7. Index. Add a partial index `CREATE INDEX IF NOT EXISTS ... ON tiles(last_access) WHERE pinned = 0`
   so the sweep and the LRU window do not full-scan. Create it unconditionally on open (the current
   schema block only runs on a version mismatch) or bump the schema version so existing caches gain
   it. This adds index writes on tile insert and on the throttled last_access touch; the microSD
   write cost is bounded by the touch throttle and is worth the sweep speedup, but the plan should
   measure it on the Pi.
8. Per-source totals. Add a `per_source_totals()` cache method returning
   `Vec<(String, i64, i64)>` of `(source, bytes, rows)` over scroll rows only (`pinned = 0`),
   alongside the existing `per_source_avg`. Extend the JSON the stats handler builds in `routes.rs`
   (an inline `serde_json::json!` object, not a struct) to add a `bySource` array of
   `{ source, bytes, rows }`. The existing `perSourceAvgBytes` map stays unchanged, because the
   regions byte estimate depends on it; `bySource` is additive.

The two new behaviors (set TTL, clear scroll) reach the container only through the existing `/config`
route and one new clear route; both stay tokenless and Signal K agnostic, take an integer or nothing,
never a path or host, and never widen egress. The container never learns the day unit; the plugin
converts days to seconds before posting.

### Node plugin (`src/`)

1. Stored config. Add `cacheScrollTtlDays` (integer days, default 30, zero disables) to the
   regions-store type and its default, persisted through `saveRegionsStore`, the same store that
   holds position-warm settings. It is the source of truth the plugin reads on start and on every
   panel edit. It is not added to `schema()`.
2. Push on start. The container launch sets the `TILECACHE_SCROLL_TTL_SECS` env from the stored days
   (converted to seconds). The start `/config` payload also carries `scrollTtlSecs` folded into the
   existing `buildSourcePayload`, so the start stays a single `/config` call. The store must be loaded
   before the payload is built, so the start sequence reads the regions-store TTL ahead of the
   config push.
3. New and changed routes (all admin-gated and fail-closed, like the existing regions routes in
   `src/http/regions-routes.ts`):
   - `POST /api/cache/config { ttlDays }`: validates an integer in range (0 through 365), writes it
     to the regions-store through `saveRegionsStore` so it survives a restart, and posts
     `{ ttlSecs }` to the container's dedicated `POST /cache/scroll-ttl` route. This is the live-edit
     path.
   - `POST /api/cache/clear-scroll`: calls the new container clear route, returns
     `{ freedBytes, freedRows }`.
   - `GET /api/cache/stats`: today this is a pure `relay()` of the container stats. It changes to
     fetch the container stats, parse the body, add `ttlDays` from the regions-store, and send the
     merged object (the same fetch-and-json shape `POST /api/regions` already uses). The container's
     `bySource` passes through additively with no plugin change. There is no separate
     `GET /api/cache/config`: the panel already calls `getCacheStats` on mount, so folding `ttlDays`
     into the stats read saves a round-trip. Because of this fold, the config plumbing is modeled on
     position-warm but is not a byte-for-byte mirror of it.

### Webapp panel (`signalk-binnacle`, `src/features/prewarm/`)

A new caps-label section in `RegionsPanel.svelte`, placed after the Saved regions list and before the
Position warm section, using the existing `.section-head` spacing and a short heading in the existing
voice (for example "Scroll cache"). It is built only from the panel's existing control primitives and
introduces no one-off:

1. Breakdown. Total used against the cap (new), and a small per-source list of `{ source, bytes }`
   from `bySource` (new). It does not repeat Pinned or Scrolling cache, which the Estimate stat grid
   already renders, so each stat appears once.
2. TTL-days control. A `UnitField` (the panel's existing numeric primitive, already used for the warm
   interval and base zoom), labeled for the scroll cache age limit, unit "days", minimum 0, step 1,
   committed on change through `setCacheConfig`. Zero reads as "off".
3. Clear button. A labeled ghost button with the trash icon behind the existing `InlineConfirm` (the
   labeled-button-plus-confirm pattern the panel already uses, not the per-card icon button). On
   confirm it calls `clearScrollCache`, then reloads the stats and shows the freed amount as a muted
   info note. When nothing was cleared it shows a muted "nothing to clear" info note, not the error
   state.

The regions client (`regions-client.ts`) gains `setCacheConfig(ttlDays)` and `clearScrollCache()`,
and the `CacheStats` interface gains `bySource?` and `ttlDays?` as optional fields, matching the
existing optional two-budget fields kept for backward compatibility with older containers. The
required `perSourceAvgBytes` the estimate reads is unchanged, so the change is additive and
non-breaking.

## Data flow

- TTL set: panel `UnitField` commit to `setCacheConfig(ttlDays)` to `POST /api/cache/config` to the
  plugin writes the regions-store and posts `{ ttlSecs }` to the container's `POST /cache/scroll-ttl`,
  which updates `live_scroll_ttl_secs`. The next scheduled sweep uses the new window.
- Sweep: container interval tick to age-sweep function to chunked delete of aged unpinned rows,
  decrementing `total_bytes`. No plugin or webapp involvement. Surfaced only through the next stats
  read.
- Clear: panel confirm to `clearScrollCache()` to `POST /api/cache/clear-scroll` to container clear
  function deletes all unpinned rows, sets `total_bytes` to `pinned_bytes`, and returns freed totals
  to the plugin to the panel, which reloads stats.
- Stats: panel `getCacheStats()` to `GET /api/cache/stats` to the plugin fetches container stats,
  adds `ttlDays` from the store, returns the merged object to the panel.

## Units

The user-facing TTL is in days. The plugin converts days to seconds at the edge before seeding the
env and posting `/config`, and the container stores and compares seconds. Bytes are bytes throughout.

## Error handling

- Config validation: a non-integer, negative, or out-of-range `ttlDays` returns a 400 from the plugin
  route; the container is never posted an invalid value. Range is 0 through 365.
- Container unreachable: the cache routes return the same failure shape the existing regions routes
  return when the container is down. The panel surfaces it the same way it surfaces a failed region
  action.
- Clear with nothing to clear: the clear function returns zero freed; the panel shows a muted
  "nothing to clear" info note, not an error.
- Sweep robustness: the sweep task logs and continues on any error and never unwraps, so a transient
  SQLite error cannot wedge the TTL. The cache lock already recovers from poisoning.
- The sweep and the clear never touch a pinned row, enforced by the `pinned = 0` predicate, the same
  guard the LRU eviction uses, so a misconfigured TTL can never delete a saved region or the
  position-warm coverage.

## Known effects to accept (called out, not bugs)

- Clearing the scroll cache drops the tiles for the active view, so the chartplotter re-fetches the
  visible area on the next pan or zoom. This is the point of the clear, surfaced to the user through
  the confirm.
- Clearing the scroll cache empties most of the per-source average sample (the average is computed
  over status-200 blob rows, which are mostly scroll), so the regions byte estimate temporarily falls
  back to its default per-tile size until the cache refills. This already happens under heavy LRU
  eviction and is not new.
- The sweep interval runs on a monotonic clock, so a long Pi power-down does not advance it; the
  cold-boot startup sweep covers reboots, and suspend-resume drift is best-effort.

## Testing

Rust (`cargo test --workspace`):

- Age sweep deletes an unpinned row whose `last_access` is older than the cutoff.
- Age sweep keeps an unpinned row newer than the cutoff.
- Age sweep keeps a pinned row regardless of age.
- Age sweep with TTL zero is a no-op.
- Age sweep and clear decrement `total_bytes` by the freed bytes and leave `pinned_bytes` unchanged,
  and clear leaves `total_bytes` equal to `pinned_bytes`.
- Clear scroll deletes all unpinned rows and keeps every pinned row.
- `per_source_totals` reports correct per-source bytes and rows over scroll rows.

Node (`npm test`):

- `POST /api/cache/config` rejects a non-integer, a negative, and an over-range value with 400, and
  accepts a valid value, writing it to the regions-store and re-posting `/config` with the seconds
  value.
- `POST /api/cache/clear-scroll` relays to the container and returns the freed totals.
- `GET /api/cache/stats` merges `ttlDays` from the store and passes `bySource` through.
- All three routes are admin-gated and fail closed.

Webapp (`vitest`):

- The cache section renders the total-against-cap and the per-source list from a stats fixture, and
  does not duplicate the Pinned or Scrolling rows.
- The `UnitField` writes through `setCacheConfig` on commit.
- The clear button requires the `InlineConfirm`, calls `clearScrollCache`, reloads stats, and shows
  the freed amount, and shows the muted "nothing to clear" note on a zero result.

## Consistency notes

- TTL persistence follows the position-warm store pattern (the value lives in the regions-store), so
  panel-edited cache settings use one persistence mechanism. Two deliberate divergences are documented
  above: folding the `ttlDays` read into the stats response rather than a separate
  `GET /api/cache/config`, and using a dedicated `POST /cache/scroll-ttl` for the live edit rather than
  re-posting `/config`.
- The start `/config` push carries the TTL through the existing seam used by the cap and the budgets.
  The two dedicated container routes (`POST /cache/scroll-ttl` and `POST /cache/clear-scroll`) exist
  because neither fits the allowlist-replacing `/config` body.
- The age sweep reuses the `pinned = 0` evictability guard already in `cache.rs`; it does not reuse
  the windowed-size delete, which is a different operation.
- The panel section reuses the existing stat layout, `UnitField`, ghost button, and `InlineConfirm`
  primitives. No new control primitive is introduced.
- Units convert at the plugin edge, matching the rest of the project.
