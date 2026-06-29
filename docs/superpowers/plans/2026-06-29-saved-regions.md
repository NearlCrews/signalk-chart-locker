# Saved regions and region download Implementation Plan

> **For agentic workers:** Execute this plan with the superpowers:subagent-driven-development workflow. Each task is a self-contained TDD unit: write the failing test, run it and see it fail, write the minimal implementation, run it and see it pass, then commit. Do not batch tasks. Do not skip the red step. Fix every finding of every severity before moving on.

## Goal

Let the owner draw a box, download all covering raster overlays for it into the boat-wide cache with one action, auto-name it by place, and keep it as a durable named region in the UI. Saved regions are offline-durable within a hard-reserved regions budget R. The on-demand scroll cache is LRU-bounded within `cap - R`. The single-box v2 prewarm is superseded by a multi-region, saved, and downloadable model.

Source spec: `docs/superpowers/specs/2026-06-29-saved-regions-design.md`.

## Architecture

Four tasks, each independently gated and reviewed, in the spec's build order:

1. **Plugin: region entity and migration.** Add `SavedRegion` and `PrewarmStore` to `prewarm-store.ts`, migrate the v2 single `bbox` top-level field to a one-element `regions` list, and repoint `shouldWarm` from `insideBox(pos, config.bbox)` to `insideAnyRegion(pos, store.regions)`.

2. **Container: two-budget cache.** Bump `SCHEMA_VERSION` to 3 (the drop-and-recreate wipe triggers `needs-redownload` on persisted regions), add a `region_tiles` join table for reference-counted shared-tile pinning, add `pinned_bytes` tracking in `Inner`, gate region warm on `pinned_bytes + delta <= R`, change live-proxy and style evict-to calls to `cap - R`, extend `ConfigBody` with `capBytes` and `regionsBudgetBytes` for live delivery via POST /config, extend `/cache/stats` with the two-budget split, add `DELETE /cache/region/:id` for per-region delete, and add `region_id` to `WarmRequest`.

3. **Container and plugin: geocode.** A new `GET /geocode?lat=&lon=` container route that reverse-geocodes via the hardcoded allowlisted host `nominatim.openstreetmap.org` with the v2 SSRF guards, `read_capped`, redirects off, and a contactable User-Agent. The plugin proxies it at `GET /api/geocode`.

4. **Webapp: Regions panel.** The prewarm panel evolves into a Regions panel. Client-side source enumeration includes sources with no bounds OR `tileCountInBbox > 0`, excluding the style basemap. The byte estimate gates against `regionsFreeBytes` from the extended stats. The download fires the geocode lookup once on the Download action (not on drag), shows the name editable, and persists the region. A region list shows cache-derived sizes, re-download, and delete. A stats summary shows the two-budget split.

## Tech Stack

- Container: Rust (Cargo workspace under `container/`), axum, tokio, rusqlite with the `bundled` feature, reqwest with rustls. Tests via `cargo test --workspace`.
- Plugin: TypeScript, `@signalk/server-api`. Tests via `node --import tsx --test test/*.test.ts`.
- Webapp: Svelte 5 runes, MapLibre GL JS 5, Vite, Vitest. Tests via `npx vitest run <file>`.

## Global Constraints

These are project-wide rules from the spec and `CLAUDE.md`. They are mandatory for every task.

- **Trust boundary and egress in the container:** the admin gate, the budget gate, and all Signal K reads stay in the plugin. The container computes geometry and makes egress fetches only; it never reads Signal K and stays tokenless. Egress is allowlist-keyed by source id (tile sources) or hardcoded host (geocoder). The container port stays off the boat LAN: the browser reaches tiles only through the plugin route. There is no client-supplied URL in any container route.
- **Allowlist-keyed sources:** tile egress is always via `expand_upstream` from `state.sources` (the pushed allowlist), never a client URL. The geocode egress targets the hardcoded constant `nominatim.openstreetmap.org` only, never a client-supplied URL.
- **SI units internally:** meters, radians, Kelvin; convert only at a display edge. Unit-bearing panel fields use `UnitField` and the server unit preference (`GET /signalk/v1/unitpreferences/active`). Never a panel-local imperial or metric toggle.
- **Two-budget hard-reserve invariants (both must hold after Task 2):**
  - `pinned_bytes + delta <= R` gates every region warm and every skip-but-pin via `pin_if_fresh`. A region warm never evicts: it stops and marks `capped` when the check fails.
  - `evict_to(cap - R)` bounds the scroll cache at `S = cap - R`. With pinned `<= R` and scroll `<= S`, the physical total stays `<= cap` automatically, so a region warm that passes the gate is guaranteed to fit.
- **No heavy native libraries in the runtime image:** no GDAL, GEOS, PROJ, or SpatiaLite. The geocode route uses reqwest only.
- **Writing style:** no em dashes, Oxford commas throughout, write "and" not the ampersand, "chartplotter" is one word, no AI-process talk in commits, changelogs, comments, or docs.
- **Build and test commands:**
  - Plugin: `npm test` (node --test via tsx), `npm run typecheck`, `npm run lint`, `npm run build`.
  - Container: `cd container && cargo test --workspace`, then `cargo clippy --workspace --all-targets -- -D warnings`, then `cargo build --release --bin tilecache`.
  - Webapp: `npm run check`, `npm run lint`, `npm run build`, and `npx vitest run <file>` for a single file.
- **Engines and CI:** the plugin `engines.node` floor is as declared in `package.json`. The SignalK plugin-ci runs the matrix on Node 22 and 24 across Linux, macOS, and Windows; code and build scripts must be cross-platform. There must be no `prepare` or `prepack` lifecycle script in `package.json` (it corrupts the App Store install-simulation CI step).
- **Biome line width:** CI runs at width 100 (`biome.json`). The pre-commit hook runs at width 80. Write new plugin and webapp TypeScript at width 100; the hook reformats to 80 on commit; CI passes at 100.

---

### Task 1: Region entity, `prewarm.json` box-to-list migration, and position-warm repoint

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/runtime/prewarm-store.ts` (add `SavedRegion`, `RegionStatus`, `PrewarmStore`, `loadPrewarmStore`, `savePrewarmStore`; keep all existing exports for backward compatibility; the old `PrewarmConfig`, `loadPrewarmConfig`, and `savePrewarmConfig` stay until Task 4 retires them).
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/runtime/position-warm.ts` (add `insideAnyRegion`; change `shouldWarm` second parameter from `box: [number, number, number, number] | null` to `regions: SavedRegion[]`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/runtime/position-warmer.ts` (change `Deps.getConfig` to `getStore: () => PrewarmStore`; pass `store.regions` and `store.positionWarm` to `shouldWarm` and the warm call respectively).
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/plugin/plugin.ts` (pass `() => loadPrewarmStore(app.getDataDirPath())` as `getStore` to `createPositionWarmer`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/test/position-warm.test.ts` (update to use `SavedRegion[]` instead of the bare bbox; keep all existing assertions, just change the `shouldWarm` call sites).
- Create `/home/dietpi/src/signalk-binnacle-companion/test/prewarm-store.test.ts`.

**Interfaces:**
- Consumes: `readJsonState`, `writeJsonState` from `./json-state.js`; `PositionWarmSettings` (unchanged); `Position` from `../shared/types.js`; `insideBox` (kept, used by `insideAnyRegion` internally).
- Produces:
  ```ts
  export type RegionStatus = 'downloading' | 'ready' | 'capped' | 'error' | 'needs-redownload'

  export interface SavedRegion {
    id: string
    name: string
    bbox: [number, number, number, number]
    sourceIds: string[]
    minzoom: number
    maxzoom: number
    createdAt: number          // Unix epoch seconds
    lastDownloadedAt: number | null
    bytes: number              // last-download snapshot
    status: RegionStatus
  }

  export interface PrewarmStore {
    regions: SavedRegion[]
    positionWarm: PositionWarmSettings
  }

  export const DEFAULT_PREWARM_STORE: PrewarmStore
  export function loadPrewarmStore(dataDir: string): PrewarmStore
  export function savePrewarmStore(dataDir: string, store: PrewarmStore): void
  ```
  ```ts
  // position-warm.ts new exports:
  export function insideAnyRegion(pos: Position, regions: SavedRegion[]): boolean
  // changed signature (second param was `box: [...] | null`):
  export function shouldWarm(
    pos: Position,
    regions: SavedRegion[],
    settings: PositionWarmSettings,
    trigger: WarmTrigger,
    nowMs: number,
  ): boolean
  ```

Steps:

- [ ] Write the failing store migration test. Create `test/prewarm-store.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { tmpdir } from 'node:os'
  import { loadPrewarmStore, savePrewarmStore, type PrewarmStore } from '../src/runtime/prewarm-store.js'

  function tmp(): string {
    return mkdtempSync(join(tmpdir(), 'prewarm-store-'))
  }

  test('fresh directory returns empty regions list and default position-warm', () => {
    const store = loadPrewarmStore(tmp())
    assert.deepEqual(store.regions, [])
    assert.equal(store.positionWarm.enabled, false)
    assert.equal(store.positionWarm.radiusMeters, 3704)
  })

  test('round-trips a saved region via savePrewarmStore and loadPrewarmStore', () => {
    const dir = tmp()
    const region: PrewarmStore['regions'][0] = {
      id: 'r1', name: 'San Francisco Bay',
      bbox: [-122.5, 37.5, -122.0, 38.0],
      sourceIds: ['depth-gebco', 'seamark'],
      minzoom: 6, maxzoom: 12,
      createdAt: 1_700_000_000, lastDownloadedAt: null, bytes: 0, status: 'ready'
    }
    const store: PrewarmStore = {
      regions: [region],
      positionWarm: { enabled: true, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: ['seamark'] }
    }
    savePrewarmStore(dir, store)
    const loaded = loadPrewarmStore(dir)
    assert.deepEqual(loaded.regions[0], region)
    assert.equal(loaded.positionWarm.enabled, true)
  })

  test('migrates a v2 bbox to a one-element regions list and drops the top-level box fields', () => {
    const dir = tmp()
    const v2 = {
      bbox: [-10.0, 50.0, 10.0, 60.0],
      sources: ['depth-gebco', 'seamark'],
      minzoom: 6,
      maxzoom: 12,
      positionWarm: { enabled: true, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: ['seamark'] }
    }
    writeFileSync(join(dir, 'prewarm.json'), JSON.stringify(v2))
    const store = loadPrewarmStore(dir)
    assert.equal(store.regions.length, 1, 'the v2 bbox becomes exactly one region')
    const r = store.regions[0]
    assert.deepEqual(r.bbox, [-10.0, 50.0, 10.0, 60.0])
    assert.deepEqual(r.sourceIds, ['depth-gebco', 'seamark'])
    assert.equal(r.minzoom, 6)
    assert.equal(r.maxzoom, 12)
    assert.equal(r.status, 'needs-redownload', 'migrated region needs a re-download')
    assert.ok(typeof r.id === 'string' && r.id.length > 0, 'migrated region has an id')
    assert.ok(typeof r.name === 'string' && r.name.length > 0, 'migrated region has a name')
    // The positionWarm block is preserved unchanged.
    assert.equal(store.positionWarm.enabled, true)
    assert.deepEqual(store.positionWarm.sources, ['seamark'])
    // The top-level box fields must be absent after migration is written back.
    const raw = JSON.parse(readFileSync(join(dir, 'prewarm.json'), 'utf8')) as Record<string, unknown>
    assert.ok(!('bbox' in raw), 'bbox field must not persist after migration')
    assert.ok(!('sources' in raw), 'sources field must not persist after migration')
    assert.ok(!('minzoom' in raw), 'minzoom field must not persist after migration')
    assert.ok(!('maxzoom' in raw), 'maxzoom field must not persist after migration')
  })

  test('a null bbox in a v2 file yields an empty regions list', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'prewarm.json'), JSON.stringify({
      bbox: null, sources: [], minzoom: 6, maxzoom: 12,
      positionWarm: { enabled: false, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: [] }
    }))
    const store = loadPrewarmStore(dir)
    assert.deepEqual(store.regions, [], 'null bbox produces no regions')
  })

  test('a second load of a migrated file does not create a duplicate region', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'prewarm.json'), JSON.stringify({
      bbox: [0.0, 0.0, 1.0, 1.0], sources: ['seamark'], minzoom: 6, maxzoom: 12,
      positionWarm: { enabled: false, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: [] }
    }))
    loadPrewarmStore(dir) // first load triggers migration and writes back
    const second = loadPrewarmStore(dir)
    assert.equal(second.regions.length, 1, 'second load must not duplicate the migrated region')
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion && npm test -- test/prewarm-store.test.ts`. Expected FAIL: `loadPrewarmStore` and `savePrewarmStore` are not exported from `prewarm-store.ts`.
- [ ] Write the failing position-warm repoint test. Append new cases to `test/position-warm.test.ts`:
  ```ts
  import { insideAnyRegion } from '../src/runtime/position-warm.js'
  import type { SavedRegion } from '../src/runtime/prewarm-store.js'

  function region(bbox: [number, number, number, number]): SavedRegion {
    return { id: 'r1', name: 'Test', bbox, sourceIds: [], minzoom: 6, maxzoom: 12, createdAt: 0, lastDownloadedAt: null, bytes: 0, status: 'ready' }
  }

  test('insideAnyRegion is true only when inside at least one region bbox', () => {
    const pos = { latitude: 37.8, longitude: -122.4 }
    assert.equal(insideAnyRegion(pos, [region([-123, 37, -122, 38])]), true)
    assert.equal(insideAnyRegion(pos, [region([0, 0, 1, 1])]), false)
    assert.equal(insideAnyRegion(pos, [region([0, 0, 1, 1]), region([-123, 37, -122, 38])]), true)
    assert.equal(insideAnyRegion(pos, []), false)
  })

  test('shouldWarm with a regions list fires outside all regions on the first fix', () => {
    const pos = { latitude: 0.5, longitude: 0.5 }
    const regions = [region([-123, 37, -122, 38])]
    assert.equal(shouldWarm(pos, regions, settings, fresh, 1_000_000), true)
  })

  test('shouldWarm with a regions list is false when inside any region', () => {
    const pos = { latitude: 37.8, longitude: -122.4 }
    const regions = [region([-123, 37, -122, 38])]
    assert.equal(shouldWarm(pos, regions, settings, fresh, 1_000_000), false)
  })

  test('shouldWarm with an empty regions list fires on the first fix (migrated null bbox)', () => {
    const pos = { latitude: 0.5, longitude: 0.5 }
    assert.equal(shouldWarm(pos, [], settings, fresh, 1_000_000), true)
  })
  ```
  Update the existing `shouldWarm` call sites in `position-warm.test.ts` to pass a `SavedRegion[]` instead of a bbox literal. The existing test at line 32 passes `[-122, 37, -121, 38]` (a bbox); change it to `[region([-122, 37, -121, 38])]`. Do the same for lines 35, 43, 47, 51, 57, 58, and 62.
- [ ] Run it and watch it fail: `npm test -- test/position-warm.test.ts`. Expected FAIL: `insideAnyRegion` is not exported; `shouldWarm` still takes a bbox as the second argument.
- [ ] Minimal implementation. In `src/runtime/prewarm-store.ts`:
  - Add `RegionStatus`, `SavedRegion`, `PrewarmStore` interfaces.
  - Add `DEFAULT_PREWARM_STORE: PrewarmStore` with `regions: []` and `positionWarm` identical to the existing `DEFAULT_PREWARM_CONFIG.positionWarm`.
  - Add the file constant `const STORE_FILE = 'prewarm.json'` (same file as before; the v2 `const FILE = 'prewarm.json'` can be removed since it is now `STORE_FILE`).
  - Add `function migrateV2(raw: Record<string, unknown>, dataDir: string): PrewarmStore`: detects a v2 shape by `'bbox' in raw` or `'sources' in raw`; if `raw.bbox` is a four-element finite-number array, creates one `SavedRegion` with `id = crypto.randomUUID()`, `name = 'Downloaded region'`, `bbox = raw.bbox`, `sourceIds = Array.isArray(raw.sources) ? raw.sources : []`, `minzoom = typeof raw.minzoom === 'number' ? raw.minzoom : 6`, `maxzoom = typeof raw.maxzoom === 'number' ? raw.maxzoom : 12`, `createdAt = Math.floor(Date.now() / 1000)`, `lastDownloadedAt = null`, `bytes = 0`, `status = 'needs-redownload'`; for null bbox yields `regions: []`; merges `positionWarm` from `raw.positionWarm` with the default; writes the migrated store back to disk via `writeJsonState`; returns the store.
  - Add `export function loadPrewarmStore(dataDir: string): PrewarmStore`: reads `prewarm.json` via `readJsonState`; if the parsed object has a `bbox` or `sources` key at the top level, calls `migrateV2`; otherwise merges with `DEFAULT_PREWARM_STORE` (deep-merge `positionWarm`).
  - Add `export function savePrewarmStore(dataDir: string, store: PrewarmStore): void` via `writeJsonState`.
  - Keep every existing export (`PositionWarmSettings`, `PrewarmConfig`, `DEFAULT_PREWARM_CONFIG`, `loadPrewarmConfig`, `savePrewarmConfig`) untouched for backward compatibility.
- [ ] In `src/runtime/position-warm.ts`:
  - Import `SavedRegion` from `./prewarm-store.js`.
  - Add `export function insideAnyRegion(pos: Position, regions: SavedRegion[]): boolean`: iterates `regions` and returns `true` when `insideBox(pos, r.bbox)` is true for any entry.
  - Change `shouldWarm` second parameter from `box: [number, number, number, number] | null` to `regions: SavedRegion[]`; replace `if (insideBox(pos, box)) return false` with `if (insideAnyRegion(pos, regions)) return false`.
- [ ] In `src/runtime/position-warmer.ts`:
  - Import `PrewarmStore`, `loadPrewarmStore` from `./prewarm-store.js`.
  - Change `Deps.getConfig: () => PrewarmConfig` to `getStore: () => PrewarmStore`.
  - In `onPosition`: replace `const config = deps.getConfig()` with `const store = deps.getStore()`; replace `const settings = config.positionWarm` with `const settings = store.positionWarm`; replace `shouldWarm(pos, config.bbox, settings, trigger, nowMs)` with `shouldWarm(pos, store.regions, settings, trigger, nowMs)`.
- [ ] In `src/plugin/plugin.ts`:
  - Import `loadPrewarmStore` alongside `loadPrewarmConfig`.
  - Change the `createPositionWarmer` call: replace `getConfig: () => loadPrewarmConfig(app.getDataDirPath())` with `getStore: () => loadPrewarmStore(app.getDataDirPath())`.
- [ ] Run both failing tests and watch them pass: `npm test -- test/prewarm-store.test.ts test/position-warm.test.ts`. Expected PASS. Then `npm run typecheck`. Expected PASS.
- [ ] Run the full test suite to confirm no regressions: `npm test`. Expected PASS on every existing test.
- [ ] Commit: `feat(plugin): add SavedRegion entity, migrate prewarm.json box to regions list, repoint position-warm`

---

### Task 2: Cache region-tile join table, per-region delete, hard-reserved two-budget accounting, and SCHEMA_VERSION 3

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/cache.rs` (bump `SCHEMA_VERSION` to 3, add `region_tiles` table, add `pinned_bytes` to `Inner`, change `put_many_pinned` signature, change `pin_if_fresh` signature, add `pin_for_region`, add `delete_region`, change `stats` return type to three values).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/state.rs` (add `live_cap_bytes: Arc<AtomicI64>` and `live_regions_budget: Arc<AtomicI64>` to `AppState`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/routes.rs` (extend `ConfigBody`; update `config` handler; update `stats` handler to the two-budget split; add `DELETE /cache/region/:id` route to `app()`; add `region_id` to `WarmBody`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/warm.rs` (add `region_id: Option<String>` to `WarmRequest`; thread it through `run`, `flush`, and the `pin_if_fresh` call in `warm_one`; read R from `st.live_regions_budget`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/fetcher.rs` (change `state.cache.evict_to(state.knobs.cap_bytes)` at line 125 to `state.cache.evict_to(state.live_cap_bytes.load(Ordering::Relaxed) - state.live_regions_budget.load(Ordering::Relaxed))`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/style.rs` (same evict_to change at line 186 in `vector_tile`).

**Interfaces:**
Consumes: existing `TileCache`, `AppState`, `Knobs`, `WarmJob`, `WarmRequest`, and `put_many_pinned`.

Produces (cache.rs changes):
```rust
// SCHEMA_VERSION = 3; ensure_schema adds after the tiles table:
//   CREATE TABLE region_tiles (
//     region_id TEXT NOT NULL,
//     source    TEXT NOT NULL,
//     z         INTEGER NOT NULL,
//     x         INTEGER NOT NULL,
//     y         INTEGER NOT NULL,
//     PRIMARY KEY (region_id, source, z, x, y)
//   );
// Inner gains:
//   pinned_bytes: i64  -- initialized at open: SELECT COALESCE(SUM(bytes),0) FROM tiles WHERE pinned=1

// Changed signatures:
pub fn put_many_pinned(
    &self,
    rows: &[WarmRow],
    regions_budget: i64,       // R; gates pinned_bytes + delta <= R
    region_id: Option<&str>,   // inserts into region_tiles when Some
    now: i64,
) -> rusqlite::Result<PutManyOutcome>

pub fn pin_if_fresh(
    &self,
    source: &str, z: u32, x: u32, y: u32,
    now: i64, fresh_secs: i64, negative_ttl_secs: i64,
    regions_budget: i64,        // R; gates pinned_bytes + tile_bytes <= R
    region_id: Option<&str>,    // inserts into region_tiles when Some
) -> rusqlite::Result<bool>

// New methods:
pub fn pin_for_region(
    &self,
    source: &str, z: u32, x: u32, y: u32,
    regions_budget: i64,
    region_id: Option<&str>,
) -> rusqlite::Result<bool>     // false when pinned_bytes + tile_bytes > R

pub fn delete_region(&self, region_id: &str) -> rusqlite::Result<()>

// Changed return type (was (i64, i64)):
pub fn stats(&self) -> rusqlite::Result<(i64, i64, i64)>  // (rows, total_bytes, pinned_bytes)
```
Produces (state.rs additions):
```rust
use std::sync::atomic::AtomicI64;
// AppState gains:
pub live_cap_bytes: Arc<AtomicI64>,        // initialized from knobs.cap_bytes
pub live_regions_budget: Arc<AtomicI64>,   // initialized to 0
```
Produces (routes.rs changes):
```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody {
    sources: Vec<ChartSource>,
    #[serde(default)] pub_base: Option<String>,    // was public_base; keep same field name
    #[serde(default)] cap_bytes: Option<i64>,
    #[serde(default)] regions_budget_bytes: Option<i64>,
}

// GET /cache/stats JSON gains:
// { "rows": .., "bytes": .., "cap": .., "pinnedBytes": .., "scrollBytes": ..,
//   "regionsBudgetBytes": .., "regionsFreeBytes": .., "perSourceAvgBytes": .. }

// New route in app():
// DELETE /cache/region/:region_id -> delete_region handler

// WarmBody gains:
#[serde(default)] region_id: Option<String>,
```

Steps:

- [ ] Write the failing cache tests. Append to the `tests` module in `cache.rs` (after the existing `pin_marks_an_existing_unpinned_row_eviction_exempt` test):
  ```rust
  #[test]
  fn join_table_reference_counting_keeps_shared_tile_on_partial_delete() {
      let (_f, c) = open();
      let now = 1000i64;
      let rows = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(10, 200, Some(vec![0; 10])) }];
      // Two regions share the same tile.
      c.put_many_pinned(&rows, 2_000_000_000, Some("r1"), now).unwrap();
      c.put_many_pinned(&rows, 2_000_000_000, Some("r2"), now).unwrap();
      // Deleting r1 must not unpin the tile because r2 still references it.
      c.delete_region("r1").unwrap();
      assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "tile survives: r2 still holds a reference");
      // Deleting r2 drops the last reference; the tile demotes to unpinned and is evictable.
      c.delete_region("r2").unwrap();
      c.evict_to(0).unwrap();
      assert!(c.get("s", 0, 0, 0).unwrap().is_none(), "tile evicted after all references are removed");
  }

  #[test]
  fn region_warm_gates_on_pinned_bytes_not_total_bytes() {
      let (_f, c) = open();
      let now = 1000i64;
      // Fill the scroll cache to 900 bytes (unpinned); total_bytes = 900.
      c.put("s", 0, 0, 0, &tile(900, 200, Some(vec![0; 900])), false, now).unwrap();
      // R = 200; even though total_bytes >> R, pinned_bytes = 0 so a 150-byte region warm fits.
      let rows = vec![WarmRow { source: "s".into(), z: 0, x: 1, y: 0, tile: tile(150, 200, Some(vec![0; 150])) }];
      let out = c.put_many_pinned(&rows, 200, Some("r1"), now).unwrap();
      assert!(!out.capped, "region warm fits within R even when total_bytes >> R");
      assert_eq!(out.stored, 1);
  }

  #[test]
  fn scroll_eviction_is_bounded_at_cap_minus_r() {
      let (_f, c) = open();
      let now = 1000i64;
      // Pin 100 bytes as a region.
      let pinned = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(100, 200, Some(vec![0; 100])) }];
      c.put_many_pinned(&pinned, 2_000_000_000, Some("r1"), now).unwrap();
      // Add 300 bytes unpinned (scroll).
      c.put("s", 1, 0, 0, &tile(300, 200, Some(vec![0; 300])), false, now).unwrap();
      // cap - R = 500 - 100 = 400; evict_to(400) leaves all 300 scroll bytes and the 100 pinned.
      c.evict_to(400).unwrap();
      let (_rows, total, pinned_b) = c.stats().unwrap();
      assert_eq!(pinned_b, 100, "pinned bytes unchanged");
      assert_eq!(total, 400, "100 pinned plus 300 scroll, all within the scroll budget");
  }

  #[test]
  fn pin_for_region_refuses_when_budget_would_be_exceeded() {
      let (_f, c) = open();
      let now = 1000i64;
      c.put("s", 0, 0, 0, &tile(500, 200, Some(vec![0; 500])), false, now).unwrap();
      // R = 100; pinning a 500-byte tile would exceed R.
      let pinned = c.pin_for_region("s", 0, 0, 0, 100, Some("r1")).unwrap();
      assert!(!pinned, "pin_for_region must refuse when pinned_bytes + tile_bytes > R");
      c.evict_to(0).unwrap();
      assert!(c.get("s", 0, 0, 0).unwrap().is_none(), "the tile was not pinned and is evictable");
  }

  #[test]
  fn schema_version_3_wipe_clears_both_tables() {
      let f = NamedTempFile::new().unwrap();
      {
          let c = TileCache::open(f.path()).unwrap();
          let rows = vec![WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(10, 200, Some(vec![0; 10])) }];
          c.put_many_pinned(&rows, 2_000_000_000, Some("r1"), 1).unwrap();
      }
      // Force a version mismatch so the next open wipes both tables.
      {
          let conn = rusqlite::Connection::open(f.path()).unwrap();
          conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1).unwrap();
      }
      let c2 = TileCache::open(f.path()).unwrap();
      let (rows, total, pinned) = c2.stats().unwrap();
      assert_eq!(rows, 0, "wipe clears all tiles");
      assert_eq!(total, 0);
      assert_eq!(pinned, 0);
  }
  ```
  Also update the existing `warm_marks_capped_and_does_not_evict` test in `warm.rs` (which calls `st.cache.stats().unwrap().1`): change `.1` to `.1` (total_bytes, still the second element of the now-three-tuple). Update every test in `cache.rs` that calls `c.stats().unwrap()` and unpacks as `(rows, total)` to use `let (rows, total, _pinned)` instead.
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache`. Expected FAIL: `region_tiles` table, `pinned_bytes`, `delete_region`, `pin_for_region`, and the changed `put_many_pinned` and `stats` signatures do not exist.
- [ ] Minimal implementation in `cache.rs`:
  - Bump: `const SCHEMA_VERSION: i64 = 3;`
  - In `ensure_schema`, after the `CREATE TABLE tiles` statement add:
    ```sql
    CREATE TABLE region_tiles (
        region_id TEXT NOT NULL,
        source    TEXT NOT NULL,
        z         INTEGER NOT NULL,
        x         INTEGER NOT NULL,
        y         INTEGER NOT NULL,
        PRIMARY KEY (region_id, source, z, x, y)
    );
    ```
    Also add `DROP TABLE IF EXISTS region_tiles;` before `DROP TABLE IF EXISTS tiles;` in the version-mismatch branch so both are wiped together.
  - Add `pinned_bytes: i64` to `Inner`. In `open`, initialize: `let pinned_bytes: i64 = conn.query_row("SELECT COALESCE(SUM(bytes), 0) FROM tiles WHERE pinned = 1", [], |r| r.get(0))?;` Pass it into `Inner { conn, total_bytes, pinned_bytes }`.
  - Change `stats` to return `(i64, i64, i64)`: `Ok((rows, inner.total_bytes, inner.pinned_bytes))`.
  - Change `put_many_pinned` signature to `(&self, rows: &[WarmRow], regions_budget: i64, region_id: Option<&str>, now: i64)`. Inside the loop, change the cap check from `base + added + delta > cap_bytes` to `inner.pinned_bytes + added + delta > regions_budget`. After each successful `tx.execute`, if `region_id.is_some()` insert into `region_tiles`: `tx.execute("INSERT OR IGNORE INTO region_tiles (region_id, source, z, x, y) VALUES (?1, ?2, ?3, ?4, ?5)", params![region_id.unwrap(), r.source, r.z, r.x, r.y])?;` After the commit, update `inner.pinned_bytes += added`.
  - Change `pin_if_fresh` signature to add `regions_budget: i64, region_id: Option<&str>` at the end. After confirming freshness, look up the tile bytes: `let tile_bytes: i64 = inner.conn.query_row("SELECT bytes FROM tiles WHERE source=?1 AND z=?2 AND x=?3 AND y=?4", params![source, z, x, y], |r| r.get(0)).optional()?.unwrap_or(0);` Check `inner.pinned_bytes + tile_bytes > regions_budget`; if so, return `Ok(false)`. After pinning, `inner.pinned_bytes += tile_bytes`; if `region_id.is_some()`, insert into `region_tiles`.
  - Add `pin_for_region`: look up existing bytes; check budget; if ok, `UPDATE tiles SET pinned = 1`; update `inner.pinned_bytes`; insert into `region_tiles` if `region_id.is_some()`; return `Ok(true)`. Return `Ok(false)` when budget check fails.
  - Add `delete_region`: in one transaction, collect `(source, z, x, y)` from `region_tiles WHERE region_id = ?`; delete those join rows; for each collected tile, check refcount via `SELECT COUNT(*) FROM region_tiles WHERE source=? AND z=? AND x=? AND y=?`; if count = 0, look up bytes, `UPDATE tiles SET pinned = 0`, subtract from `inner.pinned_bytes`; commit.
- [ ] In `state.rs`:
  - Add `use std::sync::atomic::AtomicI64;` (alongside the existing `AtomicU64`).
  - Add to `AppState`: `pub live_cap_bytes: Arc<AtomicI64>`, `pub live_regions_budget: Arc<AtomicI64>`.
  - In `AppState::new`: `live_cap_bytes: Arc::new(AtomicI64::new(knobs.cap_bytes)), live_regions_budget: Arc::new(AtomicI64::new(0))`.
- [ ] In `routes.rs`:
  - Extend `ConfigBody`: add `#[serde(default)] cap_bytes: Option<i64>` and `#[serde(default)] regions_budget_bytes: Option<i64>`.
  - In the `config` handler, after clearing sources: `if let Some(c) = body.cap_bytes { st.live_cap_bytes.store(c, Ordering::Relaxed); }` and `if let Some(r) = body.regions_budget_bytes { st.live_regions_budget.store(r, Ordering::Relaxed); }`.
  - Update the `stats` handler to call `st.cache.stats().unwrap_or((0, 0, 0))`, destructure as `(rows, bytes, pinned_bytes)`, read `let cap = st.live_cap_bytes.load(Ordering::Relaxed)` and `let r_budget = st.live_regions_budget.load(Ordering::Relaxed)`, and build the JSON with `pinnedBytes: pinned_bytes`, `scrollBytes: bytes - pinned_bytes`, `regionsBudgetBytes: r_budget`, `regionsFreeBytes: (r_budget - pinned_bytes).max(0)`, plus the existing `rows`, `bytes`, `cap`, and `perSourceAvgBytes` fields.
  - Add to `app()`: `.route("/cache/region/:region_id", axum::routing::delete(delete_region_route))`.
  - Add the handler:
    ```rust
    async fn delete_region_route(State(st): State<AppState>, Path(region_id): Path<String>) -> StatusCode {
        match st.cache.delete_region(&region_id) {
            Ok(()) => StatusCode::NO_CONTENT,
            Err(e) => { eprintln!("tilecache: delete_region failed: {e}"); StatusCode::INTERNAL_SERVER_ERROR }
        }
    }
    ```
  - Add `#[serde(default)] region_id: Option<String>` to `WarmBody`. In `warm_start`, set `req.region_id = body.region_id` on the `WarmRequest`.
- [ ] In `warm.rs`:
  - Add `pub region_id: Option<String>` to `WarmRequest`.
  - Add `region_id: Option<String>` to `WarmJob` (for progress snapshots).
  - In `start_warm`, after building the job, set `job.lock().await.region_id = req.region_id.clone()`.
  - Thread `region_id` through `run`: `async fn run(st: AppState, job: ..., ..., region_id: Option<String>)`.
  - In `flush`: read `let r = st.live_regions_budget.load(Ordering::Relaxed)` and call `st.cache.put_many_pinned(batch, r, region_id.as_deref(), now)`.
  - In `warm_one` (the `pin_if_fresh` call): add `region_id: Option<&str>` parameter and pass `st.live_regions_budget.load(Ordering::Relaxed)` and `region_id` to `pin_if_fresh`.
- [ ] In `fetcher.rs` and `style.rs`: add `use std::sync::atomic::Ordering;` where needed. Change `state.cache.evict_to(state.knobs.cap_bytes)` (fetcher.rs, in `store_200`) and `state.cache.evict_to(state.knobs.cap_bytes)` (style.rs, in `vector_tile`) to `state.cache.evict_to(state.live_cap_bytes.load(Ordering::Relaxed) - state.live_regions_budget.load(Ordering::Relaxed))`.
- [ ] Run the full container suite: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test --workspace`. Expected PASS on all new and existing tests. Then `cargo clippy --workspace --all-targets -- -D warnings`. Expected PASS.
- [ ] Commit: `feat(tilecache): region-tile join table, per-region delete, hard-reserved two-budget, SCHEMA_VERSION 3`

---

### Task 3: Geocode container route and plugin proxy

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/geocode.rs`.
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/lib.rs` (add `pub mod geocode;`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/routes.rs` (add `.merge(crate::geocode::geocode_routes())` in `app()`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/http/prewarm-routes.ts` (add `query?: Record<string, string>` to `PrewarmRequest`; add `GET /api/geocode` route in `registerPrewarmRoutes`).
- Create `/home/dietpi/src/signalk-binnacle-companion/test/geocode-proxy.test.ts`.

**Interfaces:**
Consumes:
- `AppState::egress` (the egress semaphore, acquired before every egress fetch)
- `AppState::client` (built with `redirect(Policy::none())` in `state.rs`; the guarded DNS resolver rejects private IPs after resolution)
- `AppState::read_capped` (streaming body cap)
- `AppState::knobs.allow_private_egress` (dev/test flag)
- `crate::ssrf::is_forbidden_ip` (IP literal guard, same as `guarded_get`)

Produces (geocode.rs):
```rust
pub(crate) const NOMINATIM_HOST: &str = "nominatim.openstreetmap.org";
// User-Agent is identifiable and carries a contact URL per the Nominatim usage policy.
const NOMINATIM_USER_AGENT: &str =
    "signalk-binnacle-companion geocoder (+https://github.com/nearlcrews/signalk-binnacle-companion)";

pub fn geocode_routes() -> Router<AppState>
// Mounts: GET /geocode

// pub(crate) for tests:
pub(crate) fn host_is_nominatim(url: &str) -> bool

// GET /geocode?lat=&lon= behavior:
// 1. Parse lat and lon as f64; reject missing, non-finite, |lat| > 90, |lon| > 180 -> 400
// 2. Build: format!("https://{}/reverse?format=jsonv2&lat={:.6}&lon={:.6}", NOMINATIM_HOST, lat, lon)
// 3. host_is_nominatim check on the built URL (defense in depth) -> 400 if fails
// 4. IP literal guard (same logic as guarded_get) -> 502 if forbidden IP
// 5. Acquire egress permit; send with NOMINATIM_USER_AGENT header; redirects are off at the client
// 6. read_capped the response body -> 502 if body exceeds cap or request fails
// 7. Return 200 + application/json body
```

Steps:

- [ ] Write the failing container geocode tests. Create `container/tilecache/src/geocode.rs` with the test module only:
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use crate::cache::TileCache;
      use crate::routes::app;
      use crate::state::{AppState, Knobs};
      use axum::body::Body;
      use axum::http::{Request, StatusCode};
      use std::sync::Arc;
      use tempfile::NamedTempFile;
      use tower::ServiceExt;

      fn dev_state(db: &NamedTempFile) -> AppState {
          let cache = Arc::new(TileCache::open(db.path()).unwrap());
          AppState::new(cache, Knobs { allow_private_egress: true, ..Default::default() })
      }

      #[tokio::test]
      async fn geocode_returns_400_for_missing_or_invalid_lat_lon() {
          let db = NamedTempFile::new().unwrap();
          let router = app(dev_state(&db));
          // Missing lat.
          let r = router.clone().oneshot(Request::get("/geocode?lon=-122.4").body(Body::empty()).unwrap()).await.unwrap();
          assert_eq!(r.status(), StatusCode::BAD_REQUEST, "missing lat must be 400");
          // Missing lon.
          let r2 = router.clone().oneshot(Request::get("/geocode?lat=37.7").body(Body::empty()).unwrap()).await.unwrap();
          assert_eq!(r2.status(), StatusCode::BAD_REQUEST, "missing lon must be 400");
          // Out-of-range lat (> 90).
          let r3 = router.clone().oneshot(Request::get("/geocode?lat=91.0&lon=-122.4").body(Body::empty()).unwrap()).await.unwrap();
          assert_eq!(r3.status(), StatusCode::BAD_REQUEST, "lat > 90 must be 400");
          // Out-of-range lon (> 180).
          let r4 = router.oneshot(Request::get("/geocode?lat=37.7&lon=181.0").body(Body::empty()).unwrap()).await.unwrap();
          assert_eq!(r4.status(), StatusCode::BAD_REQUEST, "lon > 180 must be 400");
      }

      #[test]
      fn host_is_nominatim_accepts_only_the_allowlisted_host() {
          assert!(host_is_nominatim(&format!("https://{}/reverse?format=jsonv2&lat=37.77&lon=-122.41", NOMINATIM_HOST)));
          assert!(!host_is_nominatim("https://evil.example/reverse"));
          assert!(!host_is_nominatim("https://nominatim.openstreetmap.org.evil.example/reverse"));
      }
  }
  ```
  Add `pub mod geocode;` to `lib.rs` (alphabetically between `fetcher` and `geom`). Add `.merge(crate::geocode::geocode_routes())` to `app()` in `routes.rs`.
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache geocode`. Expected FAIL: `geocode_routes`, `host_is_nominatim`, and `NOMINATIM_HOST` are not defined.
- [ ] Write the failing plugin proxy test. Create `test/geocode-proxy.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { registerPrewarmRoutes, type PrewarmRouter, type PrewarmRequest, type PrewarmResponse } from '../src/http/prewarm-routes.js'
  import { fakeApp } from './helpers.js'

  interface FullRequest extends PrewarmRequest {
    query?: Record<string, string>
  }

  function makeRouter(): { calls: Array<{ method: string; path: string; handler: (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }>; router: PrewarmRouter } {
    const calls: Array<{ method: string; path: string; handler: (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }> = []
    return {
      calls,
      router: {
        get(path, handler) { calls.push({ method: 'GET', path, handler: handler as (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }) },
        post(path, handler) { calls.push({ method: 'POST', path, handler: handler as (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }) }
      }
    }
  }

  test('registerPrewarmRoutes mounts GET /api/geocode', () => {
    const { router, calls } = makeRouter()
    registerPrewarmRoutes(router, fakeApp(), () => '127.0.0.1:9999')
    assert.ok(calls.some(c => c.method === 'GET' && c.path === '/api/geocode'), 'geocode route must be mounted')
  })

  test('GET /api/geocode proxies lat and lon to the container and returns the response', async () => {
    const fetched: string[] = []
    const fetchImpl = async (url: string) => {
      fetched.push(url)
      return new Response(JSON.stringify({ display_name: 'Test City' }), { status: 200 })
    }
    const { router, calls } = makeRouter()
    registerPrewarmRoutes(router, fakeApp(), () => '127.0.0.1:9999', { fetchImpl })
    const route = calls.find(c => c.path === '/api/geocode')!
    const responded: Array<{ status: number; body: unknown }> = []
    const res: PrewarmResponse = {
      status(code) { responded.push({ status: code, body: null }); return res },
      json(body) { if (responded.length) responded[responded.length - 1].body = body },
      end() {}
    }
    await route.handler({ params: {}, body: null, query: { lat: '37.77', lon: '-122.41' } }, res)
    assert.ok(fetched.length === 1, 'exactly one upstream fetch')
    assert.ok(fetched[0].includes('lat=37.77'), 'lat forwarded')
    assert.ok(fetched[0].includes('lon=-122.41'), 'lon forwarded')
    assert.equal(responded[0]?.status, 200)
  })

  test('GET /api/geocode returns 400 when lat or lon is missing', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 })
    const { router, calls } = makeRouter()
    registerPrewarmRoutes(router, fakeApp(), () => '127.0.0.1:9999', { fetchImpl })
    const route = calls.find(c => c.path === '/api/geocode')!
    const responded: Array<{ status: number }> = []
    const res: PrewarmResponse = {
      status(code) { responded.push({ status: code }); return res },
      json() {},
      end() {}
    }
    await route.handler({ params: {}, body: null, query: {} }, res)
    assert.equal(responded[0]?.status, 400)
  })
  ```
- [ ] Run it and watch it fail: `npm test -- test/geocode-proxy.test.ts`. Expected FAIL: `GET /api/geocode` is not mounted; `PrewarmRequest` has no `query` field.
- [ ] Minimal container implementation. Above the test module in `geocode.rs`, add the production code:
  ```rust
  //! Reverse-geocode proxy. Targets the hardcoded allowlisted host nominatim.openstreetmap.org
  //! only, via the v2 SSRF guards (IP literal check, guarded DNS resolver, redirects off, body cap).
  //! The User-Agent is identifiable and contactable per the Nominatim usage policy. The lookup fires
  //! at most once per Download action; the panel never triggers it on rectangle drag.

  use crate::state::AppState;
  use axum::{
      extract::{Query, State},
      http::{header, StatusCode},
      response::{IntoResponse, Response},
      routing::get,
      Router,
  };
  use serde::Deserialize;

  pub(crate) const NOMINATIM_HOST: &str = "nominatim.openstreetmap.org";
  const NOMINATIM_USER_AGENT: &str =
      "signalk-binnacle-companion geocoder (+https://github.com/nearlcrews/signalk-binnacle-companion)";

  pub fn geocode_routes() -> Router<AppState> {
      Router::new().route("/geocode", get(geocode))
  }

  #[derive(Deserialize)]
  struct GeocodeQuery {
      lat: Option<f64>,
      lon: Option<f64>,
  }

  /// True when the URL's host is exactly nominatim.openstreetmap.org (case-insensitive).
  pub(crate) fn host_is_nominatim(url: &str) -> bool {
      reqwest::Url::parse(url)
          .ok()
          .and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case(NOMINATIM_HOST)))
          .unwrap_or(false)
  }

  async fn geocode(State(st): State<AppState>, Query(q): Query<GeocodeQuery>) -> Response {
      let (lat, lon) = match (q.lat, q.lon) {
          (Some(la), Some(lo))
              if la.is_finite() && lo.is_finite() && la.abs() <= 90.0 && lo.abs() <= 180.0 =>
          {
              (la, lo)
          }
          _ => return StatusCode::BAD_REQUEST.into_response(),
      };
      let url = format!(
          "https://{}/reverse?format=jsonv2&lat={:.6}&lon={:.6}",
          NOMINATIM_HOST, lat, lon
      );
      // Defense in depth: confirm the built URL still targets the allowlisted host.
      if !host_is_nominatim(&url) {
          return StatusCode::BAD_REQUEST.into_response();
      }
      // IP literal guard: reuses the same logic as guarded_get.
      if !st.knobs.allow_private_egress {
          if let Ok(parsed) = reqwest::Url::parse(&url) {
              if let Some(host) = parsed.host_str() {
                  let bare = host.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(host);
                  if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
                      if crate::ssrf::is_forbidden_ip(ip) {
                          return StatusCode::BAD_GATEWAY.into_response();
                      }
                  }
              }
          }
      }
      // Egress semaphore (same slot as tile fetches so geocode is bounded by EGRESS_CONCURRENCY).
      let _permit = match st.egress.acquire().await {
          Ok(p) => p,
          Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
      };
      // Send with the contactable User-Agent, overriding the client-level tile-cache UA.
      // The client is built with redirect(Policy::none()), so redirects are already off.
      let resp = match st
          .client
          .get(&url)
          .header(reqwest::header::USER_AGENT, NOMINATIM_USER_AGENT)
          .send()
          .await
      {
          Ok(r) => r,
          Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
      };
      if !resp.status().is_success() {
          return StatusCode::BAD_GATEWAY.into_response();
      }
      let body = match st.read_capped(resp).await {
          Some(b) => b,
          None => return StatusCode::BAD_GATEWAY.into_response(),
      };
      ([(header::CONTENT_TYPE, "application/json")], body).into_response()
  }
  ```
- [ ] Minimal plugin implementation. In `prewarm-routes.ts`:
  - Add `query?: Record<string, string>` to `PrewarmRequest`.
  - Add the geocode route inside `registerPrewarmRoutes` (after the existing routes, before the `return true`):
    ```ts
    router.get('/api/geocode', async (req, res) => {
      const address = withAddress(res); if (address === null) return
      const query = (req.query ?? {})
      const { lat, lon } = query
      if (!lat || !lon) { res.status(400).json({ error: 'lat and lon are required' }); return }
      return relay(res, fetchImpl(`http://${address}/geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`))
    })
    ```
- [ ] Run the container geocode tests: `cargo test -p binnacle-tilecache geocode`. Expected PASS. Then `cargo clippy -p binnacle-tilecache --all-targets -- -D warnings`. Expected PASS.
- [ ] Run the plugin geocode proxy test: `npm test -- test/geocode-proxy.test.ts`. Expected PASS. Then `npm run typecheck`. Expected PASS.
- [ ] Run both full suites to confirm no regressions: `cargo test --workspace` and `npm test`. Expected PASS on every existing test.
- [ ] Commit: `feat(tilecache,plugin): geocode container route and plugin proxy`

---

### Task 4: Webapp panel evolution, plugin region routes, client-side enumeration, estimate against regions-free, region list, geocoded name, re-download, and delete

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle/src/features/prewarm/estimate.ts` (extend `CacheStats` import; add `coveringSources`, `regionsFreeBytes`, `exceedsRegionsFree`; keep all existing exports).
- Modify `/home/dietpi/src/signalk-binnacle/src/features/prewarm/prewarm-client.ts` (extend `CacheStats` with four new fields; add `SavedRegionDto`, `RegionRequest`; add region and geocode methods to `PrewarmClient` and `createPrewarmClient`).
- Modify `/home/dietpi/src/signalk-binnacle/src/features/prewarm/PrewarmPanel.svelte` (evolve the prewarm panel into a Regions panel; reuse all existing primitives).
- Modify `/home/dietpi/src/signalk-binnacle/src/features/prewarm/estimate.test.ts` (update the `stats()` factory to include the four new fields with sane defaults; add `coveringSources` and regions-free tests).
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/http/prewarm-routes.ts` (add `delete` to `PrewarmRouter`; add `GET /api/regions`, `POST /api/regions`, `DELETE /api/regions/:id`, `GET /api/regions/:id/status`, `POST /api/regions/:id/redownload`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/runtime/prewarm-store.ts` (add `addRegion`, `updateRegion`, `removeRegion`, `listRegions` helpers).
- Create `/home/dietpi/src/signalk-binnacle-companion/test/region-routes.test.ts`.

**Interfaces:**
Consumes:
- `prewarmableSources()` from `estimate.ts` (already filters `mode === 'style'`)
- `tileCountInBbox(source, bbox, zoomRange)` from `signalk-binnacle-chart-sources` (`clipBbox` treats missing `bounds` as global, so a global source always returns count > 0 for a non-empty bbox)
- `SlideOver`, `LayerToggle`, `UnitField`, `.caps-label`, `.muted-note` (existing shared UI primitives; reused unchanged)
- `createPrewarmRectangle` (unchanged)
- `detectCompanion`, `companionApiUrl` (unchanged)

Produces (estimate.ts additions):
```ts
/** Sources that cover the drawn bbox: prewarmable sources where tileCountInBbox > 0.
 * Sources with no bounds are global and always included for a non-empty bbox.
 * The style basemap is excluded (prewarmableSources already filters it). */
export function coveringSources(
  bbox: [number, number, number, number],
  zoomRange: [number, number],
): ChartSource[]

/** Free bytes within the regions budget R (regionsBudgetBytes - pinnedBytes), floored at 0.
 * Uses the server-computed stats.regionsFreeBytes for reliability. */
export function regionsFreeBytes(stats: CacheStats): number

/** True when the estimate exceeds regionsFreeBytes (Download is disabled while true). */
export function exceedsRegionsFree(estimate: number, stats: CacheStats): boolean
```

Produces (prewarm-client.ts additions):
```ts
// CacheStats extended (new fields optional for backward compatibility with v2 tests):
export interface CacheStats {
  rows: number
  bytes: number
  cap: number
  pinnedBytes?: number
  scrollBytes?: number
  regionsBudgetBytes?: number
  regionsFreeBytes?: number
  perSourceAvgBytes: Record<string, number>
}

export interface SavedRegionDto {
  id: string
  name: string
  bbox: [number, number, number, number]
  sourceIds: string[]
  minzoom: number
  maxzoom: number
  createdAt: number
  lastDownloadedAt: number | null
  bytes: number
  status: 'downloading' | 'ready' | 'capped' | 'error' | 'needs-redownload'
  cachedBytes: number   // cache-derived from container, SELECT SUM(bytes) WHERE region_id=?
}

export interface RegionRequest {
  bbox: [number, number, number, number]
  sourceIds: string[]
  minzoom: number
  maxzoom: number
  name: string
}

// New methods added to PrewarmClient and createPrewarmClient:
getRegions(): Promise<SavedRegionDto[]>
postRegion(body: RegionRequest): Promise<{ region: SavedRegionDto; jobId: string }>
deleteRegion(id: string): Promise<void>
redownloadRegion(id: string): Promise<{ jobId: string }>
getRegionJobStatus(id: string): Promise<WarmStatus | null>
geocode(lat: number, lon: number): Promise<string | null>
```

Produces (plugin prewarm-routes.ts additions):
```ts
// PrewarmRouter gains:
delete(path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void | Promise<void>): void

// New routes mounted in registerPrewarmRoutes:
// GET  /api/regions
// POST /api/regions
// DELETE /api/regions/:id
// GET  /api/regions/:id/status
// POST /api/regions/:id/redownload
```

Steps:

- [ ] Write the failing webapp estimate tests. Update `estimate.test.ts` in `src/features/prewarm/`:
  - Update the `stats()` factory to add the four new fields (with optional defaults so existing assertions continue to pass):
    ```ts
    const stats = (over: Partial<CacheStats> = {}): CacheStats => ({
      rows: 0, bytes: 0, cap: 1_000_000_000,
      pinnedBytes: 0, scrollBytes: 0, regionsBudgetBytes: 500_000_000, regionsFreeBytes: 500_000_000,
      perSourceAvgBytes: {},
      ...over,
    });
    ```
  - Add new test cases for the new helpers:
    ```ts
    describe('coveringSources', () => {
      it('includes a global source (no bounds) for any non-empty bbox', () => {
        const bbox: [number, number, number, number] = [-122.5, 37.5, -122.0, 38.0]
        const result = coveringSources(bbox, [6, 12])
        // depth-gebco has no bounds and maxzoom 12; it covers any valid bbox.
        expect(result.some(s => s.id === 'depth-gebco')).toBe(true)
      })

      it('excludes the style basemap', () => {
        const bbox: [number, number, number, number] = [-122.5, 37.5, -122.0, 38.0]
        expect(coveringSources(bbox, [6, 12]).every(s => s.upstream.mode !== 'style')).toBe(true)
      })

      it('excludes a bounded source with no overlap with the bbox', () => {
        // depth-emodnet bounds are [-73.125, 5.625, 45.0, 90.0]; a Pacific bbox has no overlap.
        const pacific: [number, number, number, number] = [-150.0, 20.0, -120.0, 50.0]
        expect(coveringSources(pacific, [6, 12]).some(s => s.id === 'depth-emodnet')).toBe(false)
      })
    })

    describe('regionsFreeBytes', () => {
      it('returns the server-computed regionsFreeBytes from stats', () => {
        expect(regionsFreeBytes(stats({ regionsFreeBytes: 400_000_000 }))).toBe(400_000_000)
      })
      it('is floored at 0', () => {
        expect(regionsFreeBytes(stats({ regionsFreeBytes: undefined, regionsBudgetBytes: 100, pinnedBytes: 200 }))).toBe(0)
      })
    })

    describe('exceedsRegionsFree', () => {
      it('returns true when the estimate exceeds regionsFreeBytes', () => {
        expect(exceedsRegionsFree(600_000_000, stats({ regionsFreeBytes: 500_000_000 }))).toBe(true)
      })
      it('returns false when the estimate fits', () => {
        expect(exceedsRegionsFree(100_000, stats({ regionsFreeBytes: 500_000_000 }))).toBe(false)
      })
    })
    ```
  - Add the new imports at the top: `import { coveringSources, regionsFreeBytes, exceedsRegionsFree } from './estimate.js';`
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/estimate.test.ts`. Expected FAIL: `coveringSources`, `regionsFreeBytes`, and `exceedsRegionsFree` are not exported.
- [ ] Write the failing plugin region routes test. Create `test/region-routes.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { mkdtempSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { registerPrewarmRoutes, type PrewarmRouter, type PrewarmRequest, type PrewarmResponse } from '../src/http/prewarm-routes.js'
  import { fakeApp } from './helpers.js'

  function makeRouter() {
    const routes: Array<{ method: string; path: string; handler: Function }> = []
    const router: PrewarmRouter = {
      get(path, handler) { routes.push({ method: 'GET', path, handler }) },
      post(path, handler) { routes.push({ method: 'POST', path, handler }) },
      delete(path, handler) { routes.push({ method: 'DELETE', path, handler }) }
    }
    return { routes, router }
  }

  function fakeRes(): { responded: Array<{ status: number; body: unknown }>; res: PrewarmResponse } {
    const responded: Array<{ status: number; body: unknown }> = []
    const res: PrewarmResponse = {
      status(code) { responded.push({ status: code, body: null }); return res },
      json(body) { if (responded.length) responded[responded.length - 1].body = body },
      end() { if (responded.length) responded[responded.length - 1].body = null }
    }
    return { responded, res }
  }

  test('registerPrewarmRoutes mounts all region routes', () => {
    const { router, routes } = makeRouter()
    registerPrewarmRoutes(router, fakeApp(), () => '127.0.0.1:9999')
    const paths = routes.map(r => `${r.method} ${r.path}`)
    assert.ok(paths.includes('GET /api/regions'), 'GET /api/regions must be mounted')
    assert.ok(paths.includes('POST /api/regions'), 'POST /api/regions must be mounted')
    assert.ok(paths.some(p => p.startsWith('DELETE /api/regions/')), 'DELETE /api/regions/:id must be mounted')
    assert.ok(paths.some(p => p.includes('/api/regions/') && p.includes('status')), 'GET /api/regions/:id/status must be mounted')
    assert.ok(paths.some(p => p.includes('/api/regions/') && p.includes('redownload')), 'POST /api/regions/:id/redownload must be mounted')
  })

  test('POST /api/regions refuses an invalid bbox with 400', async () => {
    const { router, routes } = makeRouter()
    const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
    registerPrewarmRoutes(router, fakeApp(), () => null, { dataDir })
    const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
    const { responded, res } = fakeRes()
    await route.handler({ params: {}, body: { bbox: 'not-an-array', sourceIds: [], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
    assert.equal(responded[0]?.status, 400, 'invalid bbox must yield 400')
  })

  test('POST /api/regions returns 503 when the container address is unavailable', async () => {
    const { router, routes } = makeRouter()
    const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
    registerPrewarmRoutes(router, fakeApp(), () => null, { dataDir })
    const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
    const { responded, res } = fakeRes()
    await route.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
    assert.equal(responded[0]?.status, 503, 'missing container address must yield 503')
  })

  test('GET /api/regions returns the persisted regions list', async () => {
    const { router, routes } = makeRouter()
    const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
    registerPrewarmRoutes(router, fakeApp(), () => '127.0.0.1:9999', { dataDir })
    const route = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
    const { responded, res } = fakeRes()
    await route.handler({ params: {}, body: null }, res)
    assert.equal(responded[0]?.status, 200)
    assert.ok(Array.isArray(responded[0]?.body), 'body must be an array')
  })
  ```
- [ ] Run it and watch it fail: `npm test -- test/region-routes.test.ts`. Expected FAIL: region routes are not mounted; `PrewarmRouter` has no `delete` method.
- [ ] Minimal implementation.
  - In `estimate.ts`:
    - Add the import: `import { tileCountInBbox } from 'signalk-binnacle-chart-sources';` (it is already imported; verify the `tileCountInBbox` named export exists alongside `CHART_SOURCES`).
    - Add `export function coveringSources(bbox: [number, number, number, number], zoomRange: [number, number]): ChartSource[] { return prewarmableSources().filter(s => tileCountInBbox(s, bbox, zoomRange) > 0) }`.
    - Add `export function regionsFreeBytes(stats: CacheStats): number { return Math.max(0, stats.regionsFreeBytes ?? Math.max(0, (stats.regionsBudgetBytes ?? 0) - (stats.pinnedBytes ?? 0))) }`.
    - Add `export function exceedsRegionsFree(estimate: number, stats: CacheStats): boolean { return estimate > regionsFreeBytes(stats) }`.
  - In `prewarm-client.ts`:
    - Extend `CacheStats` with four optional fields: `pinnedBytes?: number`, `scrollBytes?: number`, `regionsBudgetBytes?: number`, `regionsFreeBytes?: number`.
    - Add `SavedRegionDto` and `RegionRequest` interfaces.
    - Add the six new method signatures to `PrewarmClient`.
    - Implement them in `createPrewarmClient`:
      ```ts
      async getRegions() {
        return json<SavedRegionDto[]>(await fetchImpl(url('/regions'), authInit(token)));
      },
      async postRegion(body) {
        return json<{ region: SavedRegionDto; jobId: string }>(await fetchImpl(url('/regions'), jsonPost(body)));
      },
      async deleteRegion(id) {
        await fetchImpl(url(`/regions/${encodeURIComponent(id)}`), authInit(token, { method: 'DELETE' }));
      },
      async redownloadRegion(id) {
        return json<{ jobId: string }>(await fetchImpl(url(`/regions/${encodeURIComponent(id)}/redownload`), authInit(token, { method: 'POST' })));
      },
      async getRegionJobStatus(id) {
        const r = await fetchImpl(url(`/regions/${encodeURIComponent(id)}/status`), authInit(token));
        if (r.status === 404) return null;
        return json<WarmStatus>(r);
      },
      async geocode(lat, lon) {
        try {
          const r = await fetchImpl(url(`/geocode?lat=${lat}&lon=${lon}`), authInit(token));
          if (!r.ok) return null;
          const data = await r.json() as Record<string, unknown>;
          return typeof data.display_name === 'string' ? data.display_name : null;
        } catch { return null; }
      },
      ```
  - In `prewarm-routes.ts`:
    - Add `delete` to `PrewarmRouter`.
    - In `prewarm-store.ts`, add four small helpers that operate on a loaded store and save it back:
      ```ts
      export function addRegion(dataDir: string, region: SavedRegion): void {
        const store = loadPrewarmStore(dataDir)
        store.regions.push(region)
        savePrewarmStore(dataDir, store)
      }
      export function updateRegion(dataDir: string, id: string, patch: Partial<SavedRegion>): void {
        const store = loadPrewarmStore(dataDir)
        const idx = store.regions.findIndex(r => r.id === id)
        if (idx >= 0) store.regions[idx] = { ...store.regions[idx], ...patch }
        savePrewarmStore(dataDir, store)
      }
      export function removeRegion(dataDir: string, id: string): void {
        const store = loadPrewarmStore(dataDir)
        store.regions = store.regions.filter(r => r.id !== id)
        savePrewarmStore(dataDir, store)
      }
      export function listRegions(dataDir: string): SavedRegion[] {
        return loadPrewarmStore(dataDir).regions
      }
      ```
    - Add the five region routes in `registerPrewarmRoutes` (after the geocode route, before `return true`). The `POST /api/regions` handler:
      1. Validates `bbox` (four finite numbers, ordered), `sourceIds` (array), `minzoom` and `maxzoom` (finite, `minzoom <= maxzoom`), `name` (non-empty string); returns 400 on failure.
      2. Gets the container address via `withAddress`; returns 503 if absent.
      3. Fetches stats from the container: `await fetchImpl(http://${address}/cache/stats)`. Computes the estimate via the tile count (for the server-side re-validation, it trusts the client's sourceIds list but checks the budget): checks `pinnedBytes + estimated_bytes <= regionsBudgetBytes`; returns 400 with `{ error: 'exceeds regions budget' }` if the check fails.
      4. Creates a `SavedRegion` with `id = crypto.randomUUID()`, `status = 'downloading'`, and the validated fields; calls `addRegion(dataDir, region)`.
      5. Relays `POST /warm` to the container with `{ sources: sourceIds, bbox, minzoom, maxzoom, regionId: region.id }`.
      6. Returns 200 with `{ region, jobId }`.
    - `GET /api/regions` reads `listRegions(dataDir)` and returns them directly (the `cachedBytes` field is populated from the container stats when available; for v1 of Task 4 it may be omitted or zero).
    - `DELETE /api/regions/:id`: calls `removeRegion(dataDir, id)`, then relays `DELETE /cache/region/:id` to the container.
    - `GET /api/regions/:id/status`: looks up the most recent `jobId` for this region from an in-memory map (populated on POST), then relays `GET /warm/:jobId` to the container.
    - `POST /api/regions/:id/redownload`: loads the region, re-runs step 5 above with the same `region.id` (re-warm replaces tiles), updates `status = 'downloading'`, relays `/warm`.
  - In `PrewarmPanel.svelte`, evolve the panel to the Regions panel. Preserve every reused primitive unchanged. Key behavioral changes:
    - The source list is dynamic: `coveringSources(bbox ?? [-180, -90, 180, 90], [minzoom, maxzoom])` replaces the static `prewarmableSources()` call so only covering sources show for the current box. All are auto-selected when the box is drawn; the owner can deselect.
    - Replace `freeCapBytes(stats)` with `regionsFreeBytes(stats)` and `exceedsFreeCap` with `exceedsRegionsFree` in the gate and the DL row.
    - The Download button fires: `geocodedName = await client.geocode(centerLat, centerLon)` (once, not on drag); shows the result in an editable `<input>` field; the name defaults to a coordinate-derived string on any failure. Then `client.postRegion({ bbox, sourceIds, minzoom, maxzoom, name: editedName })`.
    - The region list section shows each `SavedRegionDto` with name, status, `cachedBytes` (formatted via `formatBytes`), last updated date, a Re-download button, and a Delete button.
    - The stats summary shows a `<dl>` with `regionsFreeBytes`, `pinnedBytes`, and `scrollBytes` from the extended stats.
    - Position-warm settings section stays unchanged.
- [ ] Run the webapp estimate tests: `npx vitest run src/features/prewarm/estimate.test.ts`. Expected PASS. Run the plugin region routes tests: `npm test -- test/region-routes.test.ts`. Expected PASS.
- [ ] Run the full webapp check: `npm run check && npm run lint && npm run build`. Expected PASS.
- [ ] Run the full plugin test suite: `npm test`. Expected PASS.
- [ ] Commit: `feat(webapp,plugin): regions panel with source enumeration, regions-free estimate gate, geocoded name, region list, re-download, and delete`

---

## Self-Review

- [ ] **Spec coverage:** confirm every requirement in `docs/superpowers/specs/2026-06-29-saved-regions-design.md` appears in exactly one task: region entity and migration (Task 1, spec sections 4 and 10), two-budget cache with join table and SCHEMA_VERSION 3 (Task 2, spec section 5), geocode route with SSRF guards and contactable UA (Task 3, spec section 7), plugin routes and panel evolution (Task 4, spec sections 6, 8, and 9).
- [ ] **Placeholder scan:** `grep -r 'TODO\|FIXME\|placeholder\|similar to Task' docs/superpowers/plans/2026-06-29-saved-regions.md` must return no matches.
- [ ] **Type consistency:** `CacheStats` in `prewarm-client.ts` and the `stats()` factory in `estimate.test.ts` must carry the four new optional fields consistently. `SavedRegion` in `prewarm-store.ts` and `SavedRegionDto` in `prewarm-client.ts` must share the same field shapes (only `cachedBytes` is added on the DTO side, computed from the cache). `RegionStatus` must include `'needs-redownload'` for the schema-wipe case.
- [ ] **Two-budget invariant verification:** Task 2's `region_warm_gates_on_pinned_bytes_not_total_bytes` test confirms the key invariant that a large scroll cache does not block a region warm that fits within R. Task 2's `scroll_eviction_is_bounded_at_cap_minus_r` confirms that `evict_to(cap - R)` bounds scroll at S. Together they prove `pinned <= R` and `scroll <= S` so `total <= cap`.
- [ ] **Geocode egress safety check:** confirm `geocode.rs` always acquires the egress semaphore, applies the IP literal guard, and uses the guarded DNS resolver via the shared `AppState::client`, and that the host allowlist check on the constructed URL is present as defense in depth on top of the hardcoded `NOMINATIM_HOST` constant.
- [ ] **Migration idempotency:** confirm `loadPrewarmStore` detects the v2 shape by the presence of `bbox` or `sources` at the top level (not by file absence), writes the migrated store back to disk in the new format, and a second load returns the migrated form without creating duplicate regions (covered by `test/prewarm-store.test.ts`).
- [ ] **Backward compatibility:** the existing `POST /api/prewarm`, `GET /api/prewarm/status/:jobId`, `POST /api/prewarm/cancel/:jobId`, `GET|POST /api/prewarm/config`, and `GET /api/cache/stats` routes remain mounted and functional after all four tasks. The `PrewarmConfig`, `loadPrewarmConfig`, and `savePrewarmConfig` exports are kept until the next release cycle explicitly removes them.
