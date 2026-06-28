# Tile cache v2 prewarm Implementation Plan

> **For agentic workers:** Execute this plan with the superpowers:subagent-driven-development workflow. Each task is a self-contained TDD unit: write the failing test, run it and see it fail, write the minimal implementation, run it and see it pass, then commit. Do not batch tasks. Do not skip the red step. Fix every finding of every severity before moving on.

## Goal

Let the boat owner prewarm a manual cruising bounding box into the shared tile cache before leaving internet, so the chartplotter dashboard renders that area offline at sea, and optionally keep a small radius around the vessel warm when it travels outside the prewarmed box. Writes stay bounded so a microSD card is not worn out: a warm never evicts, the prewarmed box is pinned and eviction-exempt, and position-warm tiles are unpinned and LRU-bound.

Source spec: `docs/superpowers/specs/2026-06-28-tilecache-v2-prewarm-design.md`. This plan implements both phases of that spec. Phase A is the prewarm box (lower risk, boat-testable first). Phase B is the off-plan position-warm loop.

## Architecture

Four codebases, one feature, built in the spec's release order:

1. `signalk-binnacle-chart-sources` (shared npm package, pure data and helpers): add the Web Mercator inverse `tileForLngLat` and the tile enumerators `tilesInBbox` and `tileCountInBbox`, mirroring the existing forward `webMercatorTileBounds`. Both the webapp and the Rust container consume the same formula.
2. `container/tilecache` (Rust crate, the one internet-egress container): add a warm-job engine reusing the v1 seams (the fetcher, the cache, the per-kind `expand_upstream`, the SSRF guards). New: a `pinned` cache column with a schema-version bump, server-side cap enforcement (a warm marks `capped` and never evicts), an on-demand per-source byte average for the estimate, the inverse projection and lazy enumeration, a warm concurrency sub-budget below `EGRESS_CONCURRENCY`, batched warm puts, and `POST /warm`, `GET /warm/:jobId`, and `POST /warm/:jobId/cancel`.
3. `signalk-binnacle-companion` (the thin Node plugin, the single source of truth): port the crows-nest admin gate, persist the box and the settings as a JSON state file under `app.getDataDirPath()`, and add the admin-gated `POST /api/prewarm`, `GET /api/prewarm/status/:jobId`, `POST /api/prewarm/cancel/:jobId`, `GET|POST /api/prewarm/config`, and `GET /api/cache/stats` proxy routes. Phase B adds the `navigation.position` position-warm loop.
4. `signalk-binnacle` (the webapp, the single input surface): a feature-detected prewarm panel in the existing SlideOver shell, drawing the box with a panel-scoped `TerraDrawRectangleMode` instance, source checkboxes from the shared registry, zoom controls, a live estimate gate, a progress poll with a 404-means-gone re-warm, and (phase B) the position-warm settings.

Data flow for a prewarm: the panel draws a rectangle, estimates `tileCountInBbox` times the per-source average from `GET /api/cache/stats` against the free cap, and refuses or clamps upfront. On Prewarm it `POST`s the box to the plugin, which persists it and forwards a compact `{ sources, bbox, minzoom, maxzoom }` to the container's `POST /warm`. The container enumerates lazily with the same inverse formula, fetches each tile through the guarded egress path, stores it pinned in a batched transaction, hard-stops at the cap, and reports progress. The panel polls `GET /api/prewarm/status/:jobId`.

## Tech Stack

- Shared package: TypeScript compiled with `tsc`, ESM with `.js` import specifiers, tests via `node --import tsx --test test/*.test.ts`.
- Container: Rust (one Cargo workspace under `container/`), axum, tokio, rusqlite with the `bundled` feature, reqwest with rustls, a pure-Rust WKB decoder elsewhere, `tower::ServiceExt` for route tests.
- Plugin: TypeScript, `@signalk/server-api`, tests via `node --import tsx --test test/*.test.ts`.
- Webapp: Svelte 5 runes, MapLibre GL JS 5, terra-draw `^1.31.0` with terra-draw-maplibre-gl-adapter `^1.4.1`, Vite, tests via Vitest.

## Global Constraints

These are project-wide rules copied from the spec and the project CLAUDE.md. They are mandatory for every task.

- **Single input, single source of truth:** the webapp map panel is the only input surface, the companion plugin is the only source of truth (it persists the box and the settings and runs the position-warm loop), and the container is a dumb warm executor. There is no bbox field in the plugin `schema()`, so there is no second surface and no drift.
- **SI units internally:** meters, radians, and Kelvin. Convert only at a display edge, following the server unit preference. Unit-bearing fields in the panel (the byte estimate, and in phase B the move threshold and the radius) go through the shared `UnitField`, never a hardcoded nautical-mile or byte unit and never a panel-local imperial or metric toggle. Read the server unit preference: `GET /signalk/v1/applicationData/user/unitpreferences/1.0.0` (per-user override) resolved against `GET /signalk/v1/unitpreferences/presets/{name}`, falling back to `GET /signalk/v1/unitpreferences/active`, then to metric. The imperial length signal is `categories.length.targetUnit === 'foot'`.
- **No heavy native libraries in the runtime image:** no GDAL, GEOS, PROJ, or SpatiaLite. The warm engine reuses `rusqlite` with `bundled` and the existing reqwest client. No new native dependency.
- **Deterministic numerics:** FMA contraction is disabled on x86_64 via `container/.cargo/config.toml`; aarch64 relies on Rust's default of no FMA contraction and no fast-math. Preserve expression order. Use `total_cmp`, not `partial_cmp().unwrap()`, on any sort a non-finite float could reach. The inverse projection is same-formula parity (not bit-exact), because the container hard-stops at the cap, so a boundary-tile difference between the TS estimate and the Rust enumeration is harmless.
- **The trust boundary stays in the webapp and the JS plugin:** the Signal K read (the vessel position for position-warm) stays in the JS plugin. The container never reads Signal K, stays tokenless, and is Signal K agnostic (the warm takes explicit geometry, never a Signal K path). The warm path adds no new SSRF or open-URL hole: it is allowlist-keyed by source id resolved against `state.sources`, routed through `expand_upstream` and the guarded fetch (the literal-IP guard, the guarded resolver, redirects off, the body cap, and the content-type validation), exactly like the live proxy. There is no client-supplied URL. The container serves bytes and a stale marker; it never decides what is safe to show.
- **The container port stays off the boat LAN:** the browser reaches tiles only through the plugin route, and `signalkAccessiblePorts` keeps the container port private. The plugin reaches the container via the resolved private address.
- **Writing style (prose, comments, commits, docs, file content):** no em dashes, use the Oxford comma, write "and" not the ampersand, "chartplotter" is one word. Never describe any AI or review process in any user-facing or repo-facing writing.
- **Build and test commands:**
  - Shared package: `npm run typecheck`, `npm test`, `npm run build`.
  - Plugin: `npm test` (node --test via tsx), `npm run typecheck`, `npm run lint`, `npm run build`.
  - Container (Cargo workspace): `cd container && cargo test --workspace`, then `cargo clippy --workspace --all-targets -- -D warnings`, then `cargo build --release --bin router` (and the tilecache binary), then the image build.
  - Webapp: `npm run check`, `npm run lint`, `npm run build`, and `npx vitest run <file>` for a single file.
- **Engines and CI:** the plugin advertises `engines.node` `>=20.3.0` in `package.json`. The SignalK reusable plugin-ci runs the matrix on Node 22 and 24 across Linux, macOS, and Windows, so code and build scripts must pass on the lowest advertised engine and be cross-platform (no unix-only `rm`; use a Node clean script). There must be no `prepare` or `prepack` lifecycle script in the plugin `package.json` (it corrupts the App Store install-simulation CI step).

---

## Phase A: the prewarm box

### Task 1 [Phase A]: shared `tileForLngLat` (the Web Mercator inverse)

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-chart-sources/src/mercator.ts` (today lines 1-18 hold only `webMercatorTileBounds`; add the inverse below it).
- Create `/home/dietpi/src/signalk-binnacle-chart-sources/test/mercator.test.ts`.

**Interfaces:**
- Consumes: `z`, `x`, `y` semantics from the existing `webMercatorTileBounds`.
- Produces: `export function tileForLngLat (lng: number, lat: number, z: number): { x: number, y: number }` and `export const MAX_MERCATOR_LAT = 85.0511287798066`.

Steps:

- [ ] Write the failing test. Add to `test/mercator.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { tileForLngLat, webMercatorTileBounds, MAX_MERCATOR_LAT } from '../src/mercator.js'

  test('tileForLngLat returns 0,0 at zoom 0', () => {
    assert.deepEqual(tileForLngLat(0, 0, 0), { x: 0, y: 0 })
    assert.deepEqual(tileForLngLat(179, -80, 0), { x: 0, y: 0 })
  })

  test('tileForLngLat floors to the slippy tile containing the point', () => {
    // null island at zoom 1 is the bottom-right of the top-left quadrant boundary: x=1, y=1.
    assert.deepEqual(tileForLngLat(0, 0, 1), { x: 1, y: 1 })
    // far north-west corner is tile 0,0; far south-east corner is tile 3,3 at zoom 2.
    assert.deepEqual(tileForLngLat(-180, MAX_MERCATOR_LAT, 2), { x: 0, y: 0 })
    assert.deepEqual(tileForLngLat(179.999, -MAX_MERCATOR_LAT, 2), { x: 3, y: 3 })
  })

  test('tileForLngLat clamps latitude to the Mercator limit and stays in range', () => {
    const beyond = tileForLngLat(0, 89, 4)
    const atLimit = tileForLngLat(0, MAX_MERCATOR_LAT, 4)
    assert.deepEqual(beyond, atLimit, 'a latitude beyond the limit clamps to the limit tile')
    assert.ok(beyond.y >= 0 && beyond.y < 2 ** 4)
  })

  test('the inverse lands inside its own forward tile bounds', () => {
    const z = 9
    const lng = -122.4194
    const lat = 37.7749
    const { x, y } = tileForLngLat(lng, lat, z)
    const [minX, minY, maxX, maxY] = webMercatorTileBounds(z, x, y)
    const mx = (lng / 180) * 20037508.342789244
    const latRad = (lat * Math.PI) / 180
    const my = (Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) * 20037508.342789244
    assert.ok(mx >= minX && mx <= maxX, 'x falls within the tile')
    assert.ok(my >= minY && my <= maxY, 'y falls within the tile')
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-chart-sources && npm test`. Expected FAIL (`tileForLngLat` and `MAX_MERCATOR_LAT` are not exported).
- [ ] Minimal implementation. Append to `src/mercator.ts`:
  ```ts
  // The Web Mercator latitude limit (about plus or minus 85.0511 degrees). Beyond it the projection is
  // undefined, so callers clamp to it before projecting.
  export const MAX_MERCATOR_LAT = 85.0511287798066

  /**
   * The standard slippy-tile floor: the integer tile z/x/y that contains (lng, lat). This is the inverse
   * of webMercatorTileBounds. Unlike the forward direction it need not be bit-exact across the TS and the
   * Rust; it only selects which integer tiles to enumerate, and those tiles then flow through the same
   * forward expand path and produce the same cache key. The Rust container carries the same formula.
   */
  export function tileForLngLat (lng: number, lat: number, z: number): { x: number, y: number } {
    const n = 2 ** z
    const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
    const latRad = (clampedLat * Math.PI) / 180
    const xf = Math.floor(((lng + 180) / 360) * n)
    const yf = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)
    const max = n - 1
    return {
      x: Math.min(max, Math.max(0, xf)),
      y: Math.min(max, Math.max(0, yf))
    }
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-chart-sources && npm test`. Expected PASS. Then `npm run typecheck`. Expected PASS.
- [ ] Commit: `feat(chart-sources): add tileForLngLat web mercator inverse`

### Task 2 [Phase A]: shared `tilesInBbox` and `tileCountInBbox` (the enumerators)

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-chart-sources/src/mercator.ts` (append the enumerators after `tileForLngLat`).
- Modify `/home/dietpi/src/signalk-binnacle-chart-sources/src/index.ts` (line 2 today exports `webMercatorTileBounds`; add the new exports).
- Modify `/home/dietpi/src/signalk-binnacle-chart-sources/test/mercator.test.ts` (append cases).

**Interfaces:**
- Consumes: `ChartSource` from `./types.js` (`minzoom`, `maxzoom`, optional `bounds: [number, number, number, number]`), and `tileForLngLat`.
- Produces:
  - `export type ZXY = { z: number, x: number, y: number }`
  - `export function tileCountInBbox (source: ChartSource, bbox: [number, number, number, number], zoomRange: [number, number]): number`
  - `export function tilesInBbox (source: ChartSource, bbox: [number, number, number, number], zoomRange: [number, number]): ZXY[]`

Steps:

- [ ] Write the failing test. Append to `test/mercator.test.ts`:
  ```ts
  import { tilesInBbox, tileCountInBbox } from '../src/mercator.js'
  import type { ChartSource } from '../src/types.js'

  const xyz = (over: Partial<ChartSource> = {}): ChartSource => ({
    id: 's', title: 'S', tileSize: 256, minzoom: 0, maxzoom: 18, attribution: '',
    upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}.png' }, ...over
  })

  test('tileCountInBbox counts the tile rectangle at each zoom', () => {
    // The whole world at zoom 0 is one tile; at zoom 1 it is four.
    assert.equal(tileCountInBbox(xyz(), [-179, -80, 179, 80], [0, 0]), 1)
    assert.equal(tileCountInBbox(xyz(), [-179, -80, 179, 80], [0, 1]), 5)
  })

  test('tilesInBbox enumerates exactly tileCountInBbox tiles', () => {
    const bbox: [number, number, number, number] = [-10, 40, 10, 55]
    const range: [number, number] = [4, 7]
    assert.equal(tilesInBbox(xyz(), bbox, range).length, tileCountInBbox(xyz(), bbox, range))
  })

  test('the zoom range clamps to the source min and max zoom', () => {
    const src = xyz({ minzoom: 5, maxzoom: 8 })
    const tiles = tilesInBbox(src, [-10, 40, 10, 55], [0, 20])
    assert.ok(tiles.every((t) => t.z >= 5 && t.z <= 8))
  })

  test('the bbox clips to the source bounds', () => {
    const bounded = xyz({ bounds: [0, 0, 5, 5] })
    const unbounded = xyz()
    const range: [number, number] = [6, 6]
    assert.ok(
      tileCountInBbox(bounded, [-20, -20, 20, 20], range) < tileCountInBbox(unbounded, [-20, -20, 20, 20], range)
    )
  })

  test('an antimeridian-crossing box is rejected (empty) in v2', () => {
    assert.deepEqual(tilesInBbox(xyz(), [170, -10, -170, 10], [3, 3]), [])
    assert.equal(tileCountInBbox(xyz(), [170, -10, -170, 10], [3, 3]), 0)
  })

  test('a non-finite or degenerate box yields nothing', () => {
    assert.equal(tileCountInBbox(xyz(), [Number.NaN, 0, 1, 1], [2, 2]), 0)
    assert.equal(tileCountInBbox(xyz(), [5, 5, 5, 5], [2, 2]), 0)
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-chart-sources && npm test`. Expected FAIL (the enumerators are not exported).
- [ ] Minimal implementation. Append to `src/mercator.ts`:
  ```ts
  import type { ChartSource } from './types.js'

  export type ZXY = { z: number, x: number, y: number }

  // Clip the request bbox to the source bounds and the Mercator latitude limit, and reject a non-finite,
  // degenerate, or antimeridian-crossing (minLng > maxLng) box. Returns null when nothing remains.
  function clipBbox (source: ChartSource, bbox: [number, number, number, number]): [number, number, number, number] | null {
    let [minLng, minLat, maxLng, maxLat] = bbox
    if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null
    if (minLng > maxLng) return null
    if (source.bounds) {
      const [bMinLng, bMinLat, bMaxLng, bMaxLat] = source.bounds
      minLng = Math.max(minLng, bMinLng); minLat = Math.max(minLat, bMinLat)
      maxLng = Math.min(maxLng, bMaxLng); maxLat = Math.min(maxLat, bMaxLat)
    }
    minLat = Math.max(minLat, -MAX_MERCATOR_LAT); maxLat = Math.min(maxLat, MAX_MERCATOR_LAT)
    if (minLng >= maxLng || minLat >= maxLat) return null
    return [minLng, minLat, maxLng, maxLat]
  }

  function zoomBounds (source: ChartSource, [zmin, zmax]: [number, number]): [number, number] {
    return [Math.max(zmin, source.minzoom), Math.min(zmax, source.maxzoom)]
  }

  // The inclusive tile rectangle [x0..x1] by [y0..y1] covering the clipped bbox at zoom z. y increases
  // downward, so the north edge (maxLat) is the smaller y.
  function tileRange (clip: [number, number, number, number], z: number): { x0: number, x1: number, y0: number, y1: number } {
    const [minLng, minLat, maxLng, maxLat] = clip
    const tl = tileForLngLat(minLng, maxLat, z)
    const br = tileForLngLat(maxLng, minLat, z)
    return { x0: tl.x, x1: br.x, y0: tl.y, y1: br.y }
  }

  /** The number of tiles a warm over this bbox and zoom range would touch. An upper-bound gate for the panel estimate. */
  export function tileCountInBbox (source: ChartSource, bbox: [number, number, number, number], zoomRange: [number, number]): number {
    const clip = clipBbox(source, bbox)
    if (!clip) return 0
    const [zmin, zmax] = zoomBounds(source, zoomRange)
    let count = 0
    for (let z = zmin; z <= zmax; z++) {
      const { x0, x1, y0, y1 } = tileRange(clip, z)
      count += (x1 - x0 + 1) * (y1 - y0 + 1)
    }
    return count
  }

  /** Enumerate every z/x/y a warm over this bbox and zoom range would touch. */
  export function tilesInBbox (source: ChartSource, bbox: [number, number, number, number], zoomRange: [number, number]): ZXY[] {
    const clip = clipBbox(source, bbox)
    if (!clip) return []
    const [zmin, zmax] = zoomBounds(source, zoomRange)
    const out: ZXY[] = []
    for (let z = zmin; z <= zmax; z++) {
      const { x0, x1, y0, y1 } = tileRange(clip, z)
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) out.push({ z, x, y })
      }
    }
    return out
  }
  ```
  Add to `src/index.ts`:
  ```ts
  export { webMercatorTileBounds, tileForLngLat, tilesInBbox, tileCountInBbox, MAX_MERCATOR_LAT, type ZXY } from './mercator.js'
  ```
  (Remove the prior `webMercatorTileBounds`-only export line so it is not duplicated.)
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-chart-sources && npm test`. Expected PASS. Then `npm run typecheck` and `npm run build`. Expected PASS.
- [ ] Commit: `feat(chart-sources): add tilesInBbox and tileCountInBbox enumerators`

### Task 3 [Phase A]: container Web Mercator inverse and lazy enumeration

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/geom.rs`.
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/lib.rs` (add `pub mod geom;` to the module list, lines 5-13).

**Interfaces:**
- Consumes: `crate::source::ChartSource` (`minzoom: u32`, `maxzoom: u32`, `bounds: Option<[f64; 4]>`).
- Produces:
  - `pub const MAX_MERCATOR_LAT: f64 = 85.0511287798066;`
  - `pub fn tile_for_lng_lat(lng: f64, lat: f64, z: u32) -> (u32, u32)`
  - `pub fn tile_count_in_bbox(source: &ChartSource, bbox: [f64; 4], zmin: u32, zmax: u32) -> u64`
  - `pub fn for_tiles_in_bbox(source: &ChartSource, bbox: [f64; 4], zmin: u32, zmax: u32, f: impl FnMut(u32, u32, u32))`

Steps:

- [ ] Write the failing test. Create `container/tilecache/src/geom.rs` with only the test module first:
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use crate::source::{ChartSource, UpstreamTemplate};

      fn src(minzoom: u32, maxzoom: u32, bounds: Option<[f64; 4]>) -> ChartSource {
          ChartSource {
              id: "s".into(), title: "S".into(),
              upstream: UpstreamTemplate::Xyz { url_template: "http://h/{z}/{x}/{y}".into() },
              tile_size: 256, minzoom, maxzoom, bounds, attribution: String::new(),
          }
      }

      #[test]
      fn tile_for_lng_lat_matches_known_slippy_values() {
          assert_eq!(tile_for_lng_lat(0.0, 0.0, 0), (0, 0));
          assert_eq!(tile_for_lng_lat(0.0, 0.0, 1), (1, 1));
          assert_eq!(tile_for_lng_lat(-180.0, MAX_MERCATOR_LAT, 2), (0, 0));
          assert_eq!(tile_for_lng_lat(179.999, -MAX_MERCATOR_LAT, 2), (3, 3));
      }

      #[test]
      fn latitude_beyond_the_limit_clamps_and_stays_in_range() {
          assert_eq!(tile_for_lng_lat(0.0, 89.0, 4), tile_for_lng_lat(0.0, MAX_MERCATOR_LAT, 4));
          let (_, y) = tile_for_lng_lat(0.0, 89.0, 4);
          assert!(y < 16);
      }

      #[test]
      fn count_matches_enumeration_and_clamps_zoom() {
          let s = src(5, 8, None);
          let mut n = 0u64;
          for_tiles_in_bbox(&s, [-10.0, 40.0, 10.0, 55.0], 0, 20, |z, _, _| {
              assert!((5..=8).contains(&z));
              n += 1;
          });
          assert_eq!(n, tile_count_in_bbox(&s, [-10.0, 40.0, 10.0, 55.0], 0, 20));
      }

      #[test]
      fn bounds_clip_and_antimeridian_and_degenerate_are_rejected() {
          let bounded = src(0, 18, Some([0.0, 0.0, 5.0, 5.0]));
          let unbounded = src(0, 18, None);
          assert!(tile_count_in_bbox(&bounded, [-20.0, -20.0, 20.0, 20.0], 6, 6) < tile_count_in_bbox(&unbounded, [-20.0, -20.0, 20.0, 20.0], 6, 6));
          assert_eq!(tile_count_in_bbox(&unbounded, [170.0, -10.0, -170.0, 10.0], 3, 3), 0); // antimeridian
          assert_eq!(tile_count_in_bbox(&unbounded, [5.0, 5.0, 5.0, 5.0], 2, 2), 0); // degenerate
          assert_eq!(tile_count_in_bbox(&unbounded, [f64::NAN, 0.0, 1.0, 1.0], 2, 2), 0); // non-finite
      }
  }
  ```
  Add `pub mod geom;` to `lib.rs` (keep the modules alphabetical: it sorts between `fetcher` and `response`).
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache geom`. Expected FAIL (no `tile_for_lng_lat`, `tile_count_in_bbox`, `for_tiles_in_bbox`, or `MAX_MERCATOR_LAT`).
- [ ] Minimal implementation. Prepend to `container/tilecache/src/geom.rs` (above the test module):
  ```rust
  //! The Web Mercator inverse and a lazy tile enumerator, the Rust mirror of the shared package
  //! `tileForLngLat`, `tilesInBbox`, and `tileCountInBbox`. Same formula as the TS copy (same-formula
  //! parity, not bit-exact: the container hard-stops at the cap, so a boundary-tile difference between the
  //! TS estimate and this enumeration is harmless). Used by the warm engine.

  use crate::source::ChartSource;
  use std::f64::consts::PI;

  /// The Web Mercator latitude limit (about plus or minus 85.0511 degrees).
  pub const MAX_MERCATOR_LAT: f64 = 85.0511287798066;

  /// The standard slippy-tile floor: the integer tile x/y at zoom z that contains (lng, lat). The result
  /// is clamped into [0, 2^z - 1].
  pub fn tile_for_lng_lat(lng: f64, lat: f64, z: u32) -> (u32, u32) {
      let n = 2f64.powi(z as i32);
      let clamped = lat.clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
      let lat_rad = clamped.to_radians();
      let xf = (((lng + 180.0) / 360.0) * n).floor();
      let yf = (((1.0 - lat_rad.tan().asinh() / PI) / 2.0) * n).floor();
      let max = (n as i64 - 1).max(0);
      let xi = (xf as i64).clamp(0, max) as u32;
      let yi = (yf as i64).clamp(0, max) as u32;
      (xi, yi)
  }

  // Clip the request bbox to the source bounds and the Mercator latitude limit, rejecting a non-finite,
  // degenerate, or antimeridian-crossing (min_lng > max_lng) box. Returns the inclusive tile rectangle per
  // zoom through the closure, after clamping the zoom range to the source.
  fn clip(source: &ChartSource, bbox: [f64; 4]) -> Option<[f64; 4]> {
      let [mut min_lng, mut min_lat, mut max_lng, mut max_lat] = bbox;
      if !bbox.iter().all(|v| v.is_finite()) {
          return None;
      }
      if min_lng > max_lng {
          return None;
      }
      if let Some([b0, b1, b2, b3]) = source.bounds {
          min_lng = min_lng.max(b0);
          min_lat = min_lat.max(b1);
          max_lng = max_lng.min(b2);
          max_lat = max_lat.min(b3);
      }
      min_lat = min_lat.max(-MAX_MERCATOR_LAT);
      max_lat = max_lat.min(MAX_MERCATOR_LAT);
      if min_lng >= max_lng || min_lat >= max_lat {
          return None;
      }
      Some([min_lng, min_lat, max_lng, max_lat])
  }

  fn zoom_bounds(source: &ChartSource, zmin: u32, zmax: u32) -> (u32, u32) {
      (zmin.max(source.minzoom), zmax.min(source.maxzoom))
  }

  // The inclusive tile rectangle (x0, x1, y0, y1) for the clipped bbox at zoom z. y increases downward, so
  // the north edge (max_lat) is the smaller y.
  fn tile_rect(clip: [f64; 4], z: u32) -> (u32, u32, u32, u32) {
      let (x0, y0) = tile_for_lng_lat(clip[0], clip[3], z);
      let (x1, y1) = tile_for_lng_lat(clip[2], clip[1], z);
      (x0, x1, y0, y1)
  }

  /// The number of tiles a warm over this bbox and zoom range would touch.
  pub fn tile_count_in_bbox(source: &ChartSource, bbox: [f64; 4], zmin: u32, zmax: u32) -> u64 {
      let Some(c) = clip(source, bbox) else { return 0 };
      let (zmin, zmax) = zoom_bounds(source, zmin, zmax);
      let mut count = 0u64;
      for z in zmin..=zmax {
          let (x0, x1, y0, y1) = tile_rect(c, z);
          count += u64::from(x1 - x0 + 1) * u64::from(y1 - y0 + 1);
      }
      count
  }

  /// Call `f(z, x, y)` for every tile a warm over this bbox and zoom range would touch, allocating nothing.
  pub fn for_tiles_in_bbox(source: &ChartSource, bbox: [f64; 4], zmin: u32, zmax: u32, mut f: impl FnMut(u32, u32, u32)) {
      let Some(c) = clip(source, bbox) else { return };
      let (zmin, zmax) = zoom_bounds(source, zmin, zmax);
      for z in zmin..=zmax {
          let (x0, x1, y0, y1) = tile_rect(c, z);
          for x in x0..=x1 {
              for y in y0..=y1 {
                  f(z, x, y);
              }
          }
      }
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache geom`. Expected PASS. Then `cargo clippy -p binnacle-tilecache --all-targets -- -D warnings`. Expected PASS.
- [ ] Commit: `feat(tilecache): add web mercator inverse and lazy tile enumeration`

### Task 4 [Phase A]: container cache `pinned` column, pinned-aware eviction, batched capped puts, per-source average

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/cache.rs` (SCHEMA_VERSION line 14, schema lines 70-92, `put` lines 122-149, `evict_to` lines 165-182, add new methods, add tests).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/fetcher.rs` (the four `cache.put` call sites at lines 124, 144, 195, and the `store_200`/`negative_cache`/revalidate paths, to pass `pinned: false`).

**Interfaces:**
- Consumes: the existing `CachedTile` struct and `Inner { conn, total_bytes }`.
- Produces:
  - `SCHEMA_VERSION` bumped from `1` to `2`, schema gains `pinned INTEGER NOT NULL DEFAULT 0`.
  - `pub fn put(&self, source: &str, z: u32, x: u32, y: u32, tile: &CachedTile, pinned: bool, now: i64) -> rusqlite::Result<PutOutcome>` (the `pinned` parameter is new).
  - `pub struct WarmRow { pub source: String, pub z: u32, pub x: u32, pub y: u32, pub tile: CachedTile }`
  - `pub struct PutManyOutcome { pub stored: usize, pub bytes_added: i64, pub capped: bool }`
  - `pub fn put_many_pinned(&self, rows: &[WarmRow], cap_bytes: i64, now: i64) -> rusqlite::Result<PutManyOutcome>`
  - `pub fn per_source_avg(&self) -> rusqlite::Result<Vec<(String, f64)>>`
  - `evict_to` excludes pinned rows.

Steps:

- [ ] Write the failing test. Add to the `tests` module in `cache.rs`:
  ```rust
  #[test]
  fn a_pinned_tile_survives_eviction_that_drops_unpinned_tiles() {
      let (_f, c) = open();
      c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), true, 1).unwrap(); // pinned box tile
      c.put("s", 0, 0, 1, &tile(10, 200, Some(vec![0; 10])), false, 2).unwrap(); // unpinned, older access wins LRU
      c.evict_to(10).unwrap();
      assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "the pinned tile is never evicted");
      assert!(c.get("s", 0, 0, 1).unwrap().is_none(), "the unpinned tile is evicted to make room");
  }

  #[test]
  fn put_many_pinned_stops_at_the_cap_and_never_evicts() {
      let (_f, c) = open();
      let rows = vec![
          WarmRow { source: "s".into(), z: 0, x: 0, y: 0, tile: tile(8, 200, Some(vec![0; 8])) },
          WarmRow { source: "s".into(), z: 0, x: 0, y: 1, tile: tile(8, 200, Some(vec![0; 8])) },
      ];
      let outcome = c.put_many_pinned(&rows, 10, 5).unwrap();
      assert_eq!(outcome.stored, 1, "only the first tile fits under the 10-byte cap");
      assert!(outcome.capped, "the batch reports capped rather than evicting");
      assert_eq!(c.stats().unwrap().1, 8, "no eviction happened");
  }

  #[test]
  fn per_source_avg_excludes_negative_cache_rows() {
      let (_f, c) = open();
      c.put("s", 0, 0, 0, &tile(100, 200, Some(vec![0; 100])), false, 1).unwrap();
      c.put("s", 0, 0, 1, &tile(0, 404, None), false, 2).unwrap(); // negative cache, excluded
      let avg = c.per_source_avg().unwrap();
      assert_eq!(avg, vec![("s".to_string(), 100.0)]);
  }
  ```
  Update the existing `tests` helpers and call sites so they pass the new `pinned` argument: change every `c.put(...)` in the test module to insert `false` before the `now` argument (for example `c.put("s", 1, 0, 0, &tile(3, 200, Some(vec![1, 2, 3])), false, 10)`).
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache cache`. Expected FAIL (the `pinned` parameter, `put_many_pinned`, `WarmRow`, and `per_source_avg` do not exist; the schema has no `pinned` column).
- [ ] Minimal implementation in `cache.rs`:
  - Bump the constant: `const SCHEMA_VERSION: i64 = 2;`
  - Add the column to the `CREATE TABLE` (after `blob BLOB,`): `pinned INTEGER NOT NULL DEFAULT 0,`. The existing version-mismatch branch already drops and recreates, so this is the v1 drop-and-recreate upgrade path; no migration code is needed.
  - Add the `pinned: bool` parameter to `put` and write it (the cache is disposable, so a column add rebuilds):
    ```rust
    pub fn put(&self, source: &str, z: u32, x: u32, y: u32, tile: &CachedTile, pinned: bool, now: i64) -> rusqlite::Result<PutOutcome> {
        let mut inner = self.lock();
        let old_bytes: Option<i64> = inner.conn.query_row(
            "SELECT bytes FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
            params![source, z, x, y], |r| r.get(0),
        ).optional()?;
        let result = inner.conn.execute(
            "INSERT OR REPLACE INTO tiles
             (source, z, x, y, content_type, strong_etag, upstream_validator, status, fetched_at, last_access, bytes, blob, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                source, z, x, y, tile.content_type, tile.strong_etag, tile.upstream_validator,
                tile.status, tile.fetched_at, now, tile.bytes, tile.blob.as_deref(), pinned as i64
            ],
        );
        match result {
            Ok(_) => { inner.total_bytes += tile.bytes - old_bytes.unwrap_or(0); Ok(PutOutcome::Stored) }
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DiskFull => Ok(PutOutcome::Degraded),
            Err(e) => Err(e),
        }
    }
    ```
  - Make `evict_to` exclude pinned rows: in the windowed `DELETE`, restrict the inner `SELECT ... FROM tiles` to `WHERE pinned = 0` (both the windowed sum source and the outer filter operate on unpinned rows only):
    ```rust
    inner.conn.execute(
        "DELETE FROM tiles WHERE rowid IN (
            SELECT rowid FROM (
                SELECT rowid, SUM(bytes) OVER (ORDER BY last_access ASC, rowid ASC) - bytes AS prior
                FROM tiles WHERE pinned = 0
            ) WHERE prior < ?1
        )",
        params![to_free],
    )?;
    ```
  - Add the warm batch types and methods:
    ```rust
    /// A tile to store as part of a warm, carrying its key and its `CachedTile`.
    pub struct WarmRow {
        pub source: String,
        pub z: u32,
        pub x: u32,
        pub y: u32,
        pub tile: CachedTile,
    }

    /// The outcome of a batched warm put: how many rows stored, the byte delta, and whether the cap was hit.
    #[derive(Debug, PartialEq, Eq)]
    pub struct PutManyOutcome {
        pub stored: usize,
        pub bytes_added: i64,
        pub capped: bool,
    }

    /// Store a batch of warm tiles pinned, in one transaction, with an explicit pre-store cap check. A warm
    /// NEVER evicts: when the next sized row would cross `cap_bytes`, it stops and reports `capped`.
    /// Negative-cache rows (zero bytes) always store. Pinned rows are eviction-exempt but still count
    /// against the cap, so the budget stays honest.
    pub fn put_many_pinned(&self, rows: &[WarmRow], cap_bytes: i64, now: i64) -> rusqlite::Result<PutManyOutcome> {
        let mut inner = self.lock();
        let base = inner.total_bytes;
        let mut added = 0i64;
        let mut stored = 0usize;
        let mut capped = false;
        {
            let tx = inner.conn.unchecked_transaction()?;
            for r in rows {
                if r.tile.bytes > 0 && base + added + r.tile.bytes > cap_bytes {
                    capped = true;
                    break;
                }
                let old: Option<i64> = tx.query_row(
                    "SELECT bytes FROM tiles WHERE source = ?1 AND z = ?2 AND x = ?3 AND y = ?4",
                    params![r.source, r.z, r.x, r.y], |row| row.get(0),
                ).optional()?;
                tx.execute(
                    "INSERT OR REPLACE INTO tiles
                     (source, z, x, y, content_type, strong_etag, upstream_validator, status, fetched_at, last_access, bytes, blob, pinned)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)",
                    params![
                        r.source, r.z, r.x, r.y, r.tile.content_type, r.tile.strong_etag, r.tile.upstream_validator,
                        r.tile.status, r.tile.fetched_at, now, r.tile.bytes, r.tile.blob.as_deref()
                    ],
                )?;
                added += r.tile.bytes - old.unwrap_or(0);
                stored += 1;
            }
            tx.commit()?;
        }
        inner.total_bytes = base + added;
        Ok(PutManyOutcome { stored, bytes_added: added, capped })
    }

    /// The mean stored byte size per source over real (status 200, blob present) tiles, excluding
    /// negative-cache rows (which would understate the average and let a warm exceed the cap). Computed on
    /// demand; `/cache/stats` is called rarely.
    pub fn per_source_avg(&self) -> rusqlite::Result<Vec<(String, f64)>> {
        let inner = self.lock();
        let mut stmt = inner.conn.prepare(
            "SELECT source, AVG(bytes) FROM tiles WHERE status = 200 AND blob IS NOT NULL GROUP BY source ORDER BY source",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
        rows.collect()
    }
    ```
  - In `fetcher.rs`, add `false` to the `pinned` slot at every `state.cache.put(...)` call (the live-proxy and revalidate paths store unpinned): `store_200` (line 124), `negative_cache` (line 144), and the 304 revalidate path (line 195).
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache cache && cargo test -p binnacle-tilecache fetcher`. Expected PASS. Then `cargo clippy -p binnacle-tilecache --all-targets -- -D warnings`. Expected PASS.
- [ ] Commit: `feat(tilecache): add pinned column, pinned-aware eviction, batched capped puts, per-source average`

### Task 5 [Phase A]: container `/cache/stats` reports the cap and the per-source average

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/routes.rs` (the `stats` handler, lines 33-36; add a route test in the `tests` module).

**Interfaces:**
- Consumes: `st.cache.stats()`, `st.cache.per_source_avg()`, and `st.knobs.cap_bytes`.
- Produces: `GET /cache/stats` JSON shape `{ "rows": <i64>, "bytes": <i64>, "cap": <i64>, "perSourceAvgBytes": { "<sourceId>": <f64>, ... } }`.

Steps:

- [ ] Write the failing test. Add to the `tests` module in `routes.rs`:
  ```rust
  #[tokio::test]
  async fn cache_stats_reports_cap_and_per_source_average() {
      let hits = Arc::new(AtomicUsize::new(0));
      let addr = spawn_stub(hits).await;
      let db = NamedTempFile::new().unwrap();
      let router = app(dev_state(&db));
      router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
      // Warm one tile through the live path so a real 200 row exists.
      router.clone().oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap()).await.unwrap();
      let resp = router.oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap()).await.unwrap();
      let (status, body) = body_string(resp).await;
      assert_eq!(status, StatusCode::OK);
      assert!(body.contains("\"cap\":"), "stats reports the byte cap");
      assert!(body.contains("\"perSourceAvgBytes\""), "stats reports the per-source average");
      assert!(body.contains("\"s\":"), "the warmed source has an average");
  }
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache routes::tests::cache_stats_reports_cap`. Expected FAIL (`cap` and `perSourceAvgBytes` are not in the JSON).
- [ ] Minimal implementation. Replace the `stats` handler in `routes.rs`:
  ```rust
  async fn stats(State(st): State<AppState>) -> Json<serde_json::Value> {
      let (rows, bytes) = st.cache.stats().unwrap_or((0, 0));
      let avg: serde_json::Map<String, serde_json::Value> = st
          .cache
          .per_source_avg()
          .unwrap_or_default()
          .into_iter()
          .map(|(source, mean)| (source, serde_json::json!(mean)))
          .collect();
      Json(serde_json::json!({
          "rows": rows,
          "bytes": bytes,
          "cap": st.knobs.cap_bytes,
          "perSourceAvgBytes": avg,
      }))
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache routes`. Expected PASS. Then `cargo clippy -p binnacle-tilecache --all-targets -- -D warnings`. Expected PASS.
- [ ] Commit: `feat(tilecache): report cap and per-source average from cache stats`

### Task 6 [Phase A]: container warm-job engine

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/warm.rs`.
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/lib.rs` (add `pub mod warm;`).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/state.rs` (add the warm registry, the warm semaphore, and the job-id counter to `AppState`, lines 74-107).
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/fetcher.rs` (raise `fetch_upstream` and `acceptable_content_type` to `pub(crate)` so the warm path reuses them; `strong_etag` and `log_cache_err` are already `pub(crate)`).

**Interfaces:**
- Consumes: `crate::state::AppState`, `crate::source::ChartSource`, `crate::geom::{tile_count_in_bbox, for_tiles_in_bbox}`, `crate::cache::{CachedTile, WarmRow}`, `crate::fetcher::{fetch_upstream, acceptable_content_type, strong_etag}`, `crate::upstream::expand_upstream`, `crate::state::now_secs`.
- Produces (in `warm.rs`):
  - `pub const WARM_CONCURRENCY: usize = 3;` (below `EGRESS_CONCURRENCY` = 8)
  - `pub const WARM_TILE_HARD_CAP: u64 = 2_000_000;`
  - `pub const WARM_JOB_TTL_SECS: i64 = 3600;`
  - `#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)] #[serde(rename_all = "lowercase")] pub enum WarmState { Running, Done, Cancelled, Capped, Error }`
  - `pub struct WarmJob { pub total: u64, pub done: u64, pub skipped: u64, pub bytes: i64, pub errors: u64, pub state: WarmState, pub cancel: Arc<AtomicBool>, pub finished_at: Option<i64> }`
  - `pub struct WarmRequest { pub sources: Vec<ChartSource>, pub bbox: [f64; 4], pub minzoom: u32, pub maxzoom: u32 }`
  - `pub enum StartError { UnknownSource(String), BadBbox(String), BadZoom(String), TooMany(u64) }`
  - `pub async fn start_warm(state: &AppState, req: WarmRequest) -> Result<String, StartError>`
  - `pub async fn warm_snapshot(state: &AppState, job_id: &str) -> Option<serde_json::Value>`
  - `pub async fn cancel_warm(state: &AppState, job_id: &str) -> bool`
- Produces (in `state.rs`, new `AppState` fields):
  - `pub warm_jobs: Arc<RwLock<HashMap<String, Arc<Mutex<WarmJob>>>>>`
  - `pub warm_semaphore: Arc<Semaphore>` (capacity `WARM_CONCURRENCY`)
  - `pub warm_seq: Arc<std::sync::atomic::AtomicU64>`

Steps:

- [ ] Write the failing test. Create `container/tilecache/src/warm.rs` with the test module first (it reuses the fetcher test's stub style):
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use crate::cache::TileCache;
      use crate::source::{ChartSource, UpstreamTemplate};
      use crate::state::Knobs;
      use axum::{routing::get, Router};
      use axum::http::header;
      use std::net::SocketAddr;
      use std::sync::Arc;
      use tempfile::NamedTempFile;
      use tokio::net::TcpListener;

      async fn stub() -> SocketAddr {
          let app = Router::new()
              .route("/img/:z/:x/:y", get(|| async { ([(header::CONTENT_TYPE, "image/png")], vec![1u8, 2, 3, 4]) }))
              .route("/missing/:z/:x/:y", get(|| async { axum::http::StatusCode::NOT_FOUND }));
          let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
          let addr = listener.local_addr().unwrap();
          tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
          tokio::time::sleep(std::time::Duration::from_millis(50)).await;
          addr
      }

      fn xyz(addr: SocketAddr, path: &str) -> ChartSource {
          ChartSource {
              id: "s".into(), title: "S".into(),
              upstream: UpstreamTemplate::Xyz { url_template: format!("http://{addr}/{path}/{{z}}/{{x}}/{{y}}") },
              tile_size: 256, minzoom: 0, maxzoom: 4, bounds: None, attribution: String::new(),
          }
      }

      async fn state(db: &NamedTempFile, knobs: Knobs, source: ChartSource) -> AppState {
          let cache = Arc::new(TileCache::open(db.path()).unwrap());
          let st = AppState::new(cache, knobs);
          st.sources.write().await.insert(source.id.clone(), source);
          st
      }

      async fn wait_done(st: &AppState, job: &str) -> serde_json::Value {
          for _ in 0..200 {
              let snap = warm_snapshot(st, job).await.unwrap();
              if snap["state"] != "running" { return snap; }
              tokio::time::sleep(std::time::Duration::from_millis(20)).await;
          }
          panic!("warm job did not finish");
      }

      fn dev() -> Knobs { Knobs { allow_private_egress: true, ..Default::default() } }

      #[tokio::test]
      async fn warm_enumerates_fetches_and_pins() {
          let addr = stub().await;
          let db = NamedTempFile::new().unwrap();
          let st = state(&db, dev(), xyz(addr, "img")).await;
          let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 1 }).await.unwrap();
          let snap = wait_done(&st, &job).await;
          assert_eq!(snap["state"], "done");
          assert!(snap["done"].as_u64().unwrap() >= 1);
          // The stored tile is pinned: an evict_to far below the total leaves it.
          st.cache.evict_to(0).unwrap();
          assert!(st.cache.get("s", 0, 0, 0).unwrap().is_some(), "the warmed box is pinned");
      }

      #[tokio::test]
      async fn warm_marks_capped_and_does_not_evict() {
          let addr = stub().await;
          let db = NamedTempFile::new().unwrap();
          // cap below one tile (4 bytes) so the first sized put trips the cap.
          let st = state(&db, Knobs { cap_bytes: 2, allow_private_egress: true, ..Default::default() }, xyz(addr, "img")).await;
          let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-10.0, -10.0, 10.0, 10.0], minzoom: 0, maxzoom: 0 }).await.unwrap();
          let snap = wait_done(&st, &job).await;
          assert_eq!(snap["state"], "capped");
          assert_eq!(st.cache.stats().unwrap().1, 0, "nothing stored, nothing evicted");
      }

      #[tokio::test]
      async fn warm_rejects_an_unknown_source_and_an_oversize_count() {
          let addr = stub().await;
          let db = NamedTempFile::new().unwrap();
          let st = state(&db, dev(), xyz(addr, "img")).await;
          let known = st.sources.read().await["s"].clone();
          let mut unknown = known.clone();
          unknown.id = "nope".into();
          assert!(matches!(start_warm(&st, WarmRequest { sources: vec![unknown], bbox: [-1.0, -1.0, 1.0, 1.0], minzoom: 0, maxzoom: 0 }).await, Err(StartError::UnknownSource(_))));
          assert!(matches!(start_warm(&st, WarmRequest { sources: vec![known.clone()], bbox: [10.0, 10.0, 5.0, 5.0], minzoom: 0, maxzoom: 0 }).await, Err(StartError::BadBbox(_))));
          // maxzoom 4 over the whole world is 1+4+16+64+256 = 341 tiles, under the hard cap; force the cap with a tiny hard cap test by zoom span if needed.
      }

      #[tokio::test]
      async fn warm_cancel_stops_between_tiles() {
          let addr = stub().await;
          let db = NamedTempFile::new().unwrap();
          let st = state(&db, dev(), xyz(addr, "img")).await;
          let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-180.0, -85.0, 180.0, 85.0], minzoom: 0, maxzoom: 4 }).await.unwrap();
          assert!(cancel_warm(&st, &job).await);
          let snap = wait_done(&st, &job).await;
          assert!(snap["state"] == "cancelled" || snap["state"] == "done");
      }
  }
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache warm`. Expected FAIL (the warm module API does not exist).
- [ ] Minimal implementation, part 1: extend `AppState` in `state.rs`. Add the imports `use std::sync::atomic::AtomicU64;` and the fields to the struct and `AppState::new`:
  ```rust
  // in struct AppState:
  pub warm_jobs: Arc<RwLock<HashMap<String, Arc<Mutex<crate::warm::WarmJob>>>>>,
  pub warm_semaphore: Arc<Semaphore>,
  pub warm_seq: Arc<AtomicU64>,
  // in AppState::new, after inflight:
  warm_jobs: Arc::new(RwLock::new(HashMap::new())),
  warm_semaphore: Arc::new(Semaphore::new(crate::warm::WARM_CONCURRENCY)),
  warm_seq: Arc::new(AtomicU64::new(0)),
  ```
- [ ] Minimal implementation, part 2: in `fetcher.rs` change `async fn fetch_upstream` to `pub(crate) async fn fetch_upstream`, change `fn acceptable_content_type` to `pub(crate) fn acceptable_content_type`, and expose the `Fetched` struct fields by making `struct Fetched` into `pub(crate) struct Fetched { pub(crate) content_type: String, pub(crate) validator: Option<String>, pub(crate) body: Bytes }`.
- [ ] Minimal implementation, part 3: write `warm.rs` (above the test module):
  ```rust
  //! The warm-job engine: enumerate a bbox lazily with the shared inverse, fetch each tile through the
  //! existing guarded egress path, and store it pinned in batched transactions. A warm NEVER evicts: it
  //! does an explicit pre-store cap check and stops at `capped`. Fan-out is bounded by a warm semaphore
  //! below the shared `EGRESS_CONCURRENCY`, so a large warm cannot starve interactive tile reads. The job
  //! registry is in memory, cleared on completion plus a TTL.

  use crate::cache::{CachedTile, WarmRow};
  use crate::fetcher::{acceptable_content_type, fetch_upstream, strong_etag};
  use crate::geom::{for_tiles_in_bbox, tile_count_in_bbox};
  use crate::source::{ChartSource, UpstreamTemplate};
  use crate::state::{now_secs, AppState};
  use crate::upstream::expand_upstream;
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::sync::Arc;

  /// Warm fetch fan-out, below the shared EGRESS_CONCURRENCY (8) so a warm cannot starve live tile reads.
  pub const WARM_CONCURRENCY: usize = 3;
  /// Reject an absurd projected tile count upfront, defeating an enumeration denial of service.
  pub const WARM_TILE_HARD_CAP: u64 = 2_000_000;
  /// How long a finished job stays queryable before the registry reaps it.
  pub const WARM_JOB_TTL_SECS: i64 = 3600;
  /// Rows flushed per batched transaction (microSD-friendly; safe under WAL and synchronous = NORMAL).
  const WARM_BATCH: usize = 64;

  #[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
  #[serde(rename_all = "lowercase")]
  pub enum WarmState {
      Running,
      Done,
      Cancelled,
      Capped,
      Error,
  }

  pub struct WarmJob {
      pub total: u64,
      pub done: u64,
      pub skipped: u64,
      pub bytes: i64,
      pub errors: u64,
      pub state: WarmState,
      pub cancel: Arc<AtomicBool>,
      pub finished_at: Option<i64>,
  }

  pub struct WarmRequest {
      pub sources: Vec<ChartSource>,
      pub bbox: [f64; 4],
      pub minzoom: u32,
      pub maxzoom: u32,
  }

  #[derive(Debug)]
  pub enum StartError {
      UnknownSource(String),
      BadBbox(String),
      BadZoom(String),
      TooMany(u64),
  }

  /// Validate the request, create the job, spawn the warm driver, and return the job id.
  pub async fn start_warm(state: &AppState, req: WarmRequest) -> Result<String, StartError> {
      if req.sources.is_empty() {
          return Err(StartError::UnknownSource("no sources".into()));
      }
      if req.minzoom > req.maxzoom {
          return Err(StartError::BadZoom(format!("minzoom {} > maxzoom {}", req.minzoom, req.maxzoom)));
      }
      let b = req.bbox;
      if !b.iter().all(|v| v.is_finite()) || b[0] >= b[2] || b[1] >= b[3] {
          return Err(StartError::BadBbox(format!("invalid bbox {b:?}")));
      }
      if b[1] < -crate::geom::MAX_MERCATOR_LAT || b[3] > crate::geom::MAX_MERCATOR_LAT {
          return Err(StartError::BadBbox("latitude beyond the web mercator limit".into()));
      }
      // Every source must be in the allowlist; a style source has no tile path.
      let mut total = 0u64;
      {
          let map = state.sources.read().await;
          for s in &req.sources {
              match map.get(&s.id) {
                  Some(known) if !matches!(known.upstream, UpstreamTemplate::Style { .. }) => {
                      total += tile_count_in_bbox(known, b, req.minzoom, req.maxzoom);
                  }
                  _ => return Err(StartError::UnknownSource(s.id.clone())),
              }
          }
      }
      if total > WARM_TILE_HARD_CAP {
          return Err(StartError::TooMany(total));
      }

      let id = format!("warm-{}", state.warm_seq.fetch_add(1, Ordering::Relaxed));
      let cancel = Arc::new(AtomicBool::new(false));
      let job = Arc::new(tokio::sync::Mutex::new(WarmJob {
          total, done: 0, skipped: 0, bytes: 0, errors: 0, state: WarmState::Running, cancel: cancel.clone(), finished_at: None,
      }));
      {
          let mut jobs = state.warm_jobs.write().await;
          reap(&mut jobs);
          jobs.insert(id.clone(), job.clone());
      }
      // Resolve the allowlisted source definitions (not the client-sent ones) so the warm uses the trusted config.
      let resolved: Vec<ChartSource> = {
          let map = state.sources.read().await;
          req.sources.iter().filter_map(|s| map.get(&s.id).cloned()).collect()
      };
      let st = state.clone();
      tokio::spawn(run(st, job, resolved, b, req.minzoom, req.maxzoom));
      Ok(id)
  }

  /// A snapshot of a job's progress as JSON, or None when the id is unknown.
  pub async fn warm_snapshot(state: &AppState, job_id: &str) -> Option<serde_json::Value> {
      let job = { state.warm_jobs.read().await.get(job_id).cloned()? };
      let j = job.lock().await;
      Some(serde_json::json!({
          "total": j.total, "done": j.done, "skipped": j.skipped,
          "bytes": j.bytes, "errors": j.errors, "state": j.state,
      }))
  }

  /// Request cooperative cancellation; returns false when the id is unknown.
  pub async fn cancel_warm(state: &AppState, job_id: &str) -> bool {
      match state.warm_jobs.read().await.get(job_id) {
          Some(job) => { job.lock().await.cancel.store(true, Ordering::Relaxed); true }
          None => false,
      }
  }

  // Drop finished jobs older than the TTL so the in-memory registry does not grow without bound.
  fn reap(jobs: &mut std::collections::HashMap<String, Arc<tokio::sync::Mutex<WarmJob>>>) {
      let now = now_secs();
      jobs.retain(|_, j| match j.try_lock() {
          Ok(g) => g.finished_at.map(|t| now - t < WARM_JOB_TTL_SECS).unwrap_or(true),
          Err(_) => true,
      });
  }

  enum Fetched {
      Tile(WarmRow),
      Negative(WarmRow),
      Skipped,
      Error,
  }

  // Fetch and classify one tile, reusing the guarded egress path. The caller holds the warm permit, so
  // this does not take it; guarded_get still takes an egress permit inside.
  async fn warm_one(st: &AppState, source: &ChartSource, z: u32, x: u32, y: u32) -> Fetched {
      let now = now_secs();
      if let Ok(Some(tile)) = st.cache.get(&source.id, z, x, y) {
          let fresh = tile.status == 200 && now - tile.fetched_at < st.knobs.fresh_secs;
          let neg = tile.status != 200 && now - tile.fetched_at < st.knobs.negative_ttl_secs;
          if fresh || neg {
              return Fetched::Skipped;
          }
      }
      let url = match expand_upstream(source, z, x, y) {
          Ok(u) => u,
          Err(_) => return Fetched::Error,
      };
      match fetch_upstream(st, &url, None).await {
          Ok((200, f)) => {
              if f.body.len() > st.knobs.max_blob_bytes || !acceptable_content_type(&f.content_type) {
                  return Fetched::Error;
              }
              Fetched::Tile(WarmRow {
                  source: source.id.clone(), z, x, y,
                  tile: CachedTile {
                      content_type: f.content_type, strong_etag: strong_etag(&f.body), upstream_validator: f.validator,
                      status: 200, fetched_at: now, last_access: now, bytes: f.body.len() as i64, blob: Some(f.body),
                  },
              })
          }
          Ok((404, _)) | Ok((204, _)) => Fetched::Negative(WarmRow {
              source: source.id.clone(), z, x, y,
              tile: CachedTile {
                  content_type: String::new(), strong_etag: String::new(), upstream_validator: None,
                  status: 404, fetched_at: now, last_access: now, bytes: 0, blob: None,
              },
          }),
          _ => Fetched::Error,
      }
  }

  // The warm driver: enumerate lazily, bound in-flight fetches to WARM_CONCURRENCY via owned permits and a
  // JoinSet, drain results into a batch, and flush each batch pinned with the pre-store cap check.
  async fn run(st: AppState, job: Arc<tokio::sync::Mutex<WarmJob>>, sources: Vec<ChartSource>, bbox: [f64; 4], zmin: u32, zmax: u32) {
      let cancel = { job.lock().await.cancel.clone() };
      let mut set: tokio::task::JoinSet<Fetched> = tokio::task::JoinSet::new();
      let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);
      let mut final_state = WarmState::Done;

      // A flat list of (source index, z, x, y) is avoided; enumerate inline and spawn bounded tasks.
      'outer: for source in &sources {
          let coords: Vec<(u32, u32, u32)> = {
              let mut v = Vec::new();
              for_tiles_in_bbox(source, bbox, zmin, zmax, |z, x, y| v.push((z, x, y)));
              v
          };
          for (z, x, y) in coords {
              if cancel.load(Ordering::Relaxed) {
                  final_state = WarmState::Cancelled;
                  break 'outer;
              }
              let permit = match st.warm_semaphore.clone().acquire_owned().await {
                  Ok(p) => p,
                  Err(_) => { final_state = WarmState::Error; break 'outer; }
              };
              let st2 = st.clone();
              let source2 = source.clone();
              set.spawn(async move {
                  let _permit = permit;
                  warm_one(&st2, &source2, z, x, y).await
              });
              // Drain any finished tasks without blocking, keeping memory flat.
              while let Some(done) = set.try_join_next() {
                  if let Ok(f) = done {
                      if !accumulate(&st, &job, &mut batch, f, &mut final_state).await {
                          // capped: stop spawning and draining.
                          cancel.store(true, Ordering::Relaxed);
                          break 'outer;
                      }
                  }
              }
          }
      }
      // Join remaining in-flight tasks.
      while let Some(done) = set.join_next().await {
          if let Ok(f) = done {
              if final_state == WarmState::Done && !accumulate(&st, &job, &mut batch, f, &mut final_state).await {
                  break;
              }
          }
      }
      // Flush the tail.
      if !batch.is_empty() {
          flush(&st, &job, &mut batch, &mut final_state).await;
      }
      let mut j = job.lock().await;
      j.state = final_state;
      j.finished_at = Some(now_secs());
  }

  // Apply one fetch result to the batch and the counters. Returns false when a flush reports capped.
  async fn accumulate(st: &AppState, job: &Arc<tokio::sync::Mutex<WarmJob>>, batch: &mut Vec<WarmRow>, f: Fetched, final_state: &mut WarmState) -> bool {
      match f {
          Fetched::Tile(row) | Fetched::Negative(row) => {
              batch.push(row);
              if batch.len() >= WARM_BATCH {
                  return flush(st, job, batch, final_state).await;
              }
              true
          }
          Fetched::Skipped => { job.lock().await.skipped += 1; true }
          Fetched::Error => { job.lock().await.errors += 1; true }
      }
  }

  // Store the current batch pinned, with the pre-store cap check. Returns false when capped.
  async fn flush(st: &AppState, job: &Arc<tokio::sync::Mutex<WarmJob>>, batch: &mut Vec<WarmRow>, final_state: &mut WarmState) -> bool {
      let now = now_secs();
      match st.cache.put_many_pinned(batch, st.knobs.cap_bytes, now) {
          Ok(outcome) => {
              let mut j = job.lock().await;
              j.done += outcome.stored as u64;
              j.bytes += outcome.bytes_added;
              batch.clear();
              if outcome.capped {
                  *final_state = WarmState::Capped;
                  return false;
              }
              true
          }
          Err(e) => {
              eprintln!("tilecache: warm flush failed: {e}");
              batch.clear();
              job.lock().await.errors += 1;
              true
          }
      }
  }
  ```
  Add `pub mod warm;` to `lib.rs`.
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache warm`. Expected PASS. Then `cargo clippy -p binnacle-tilecache --all-targets -- -D warnings`. Expected PASS.
- [ ] Commit: `feat(tilecache): add the warm-job engine with cap enforcement and pinning`

### Task 7 [Phase A]: container warm HTTP routes

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-companion/container/tilecache/src/routes.rs` (the `app` router lines 19-27; add the warm handlers and route tests).

**Interfaces:**
- Consumes: `crate::warm::{start_warm, warm_snapshot, cancel_warm, WarmRequest, StartError}`.
- Produces three routes on the existing router:
  - `POST /warm` body `{ "sources": string[], "bbox": [f64;4], "minzoom": u32, "maxzoom": u32 }` returns `200 { "jobId": "warm-N" }`, `404` on an unknown source, `400` on a bad bbox, zoom, or an over-cap tile count.
  - `GET /warm/:jobId` returns `200 { total, done, skipped, bytes, errors, state }` or `404`.
  - `POST /warm/:jobId/cancel` returns `204` or `404`.

Steps:

- [ ] Write the failing test. Add to the `tests` module in `routes.rs` (reuse the existing `spawn_stub`, `dev_state`, `config_json`, and `body_string` helpers):
  ```rust
  #[tokio::test]
  async fn warm_route_starts_a_job_and_reports_status() {
      let hits = Arc::new(AtomicUsize::new(0));
      let addr = spawn_stub(hits).await;
      let db = NamedTempFile::new().unwrap();
      let router = app(dev_state(&db));
      router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();

      let warm = router.clone().oneshot(
          Request::post("/warm").header("content-type", "application/json")
              .body(Body::from(r#"{"sources":["s"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":0,"maxzoom":1}"#)).unwrap()
      ).await.unwrap();
      let (status, body) = body_string(warm).await;
      assert_eq!(status, StatusCode::OK);
      assert!(body.contains("\"jobId\""));
      let job_id = body.split("\"jobId\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();

      let st = router.clone().oneshot(Request::get(format!("/warm/{job_id}")).body(Body::empty()).unwrap()).await.unwrap();
      assert_eq!(st.status(), StatusCode::OK);

      let cancel = router.clone().oneshot(Request::post(format!("/warm/{job_id}/cancel")).body(Body::empty()).unwrap()).await.unwrap();
      assert_eq!(cancel.status(), StatusCode::NO_CONTENT);

      let unknown = router.clone().oneshot(Request::get("/warm/nope").body(Body::empty()).unwrap()).await.unwrap();
      assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
  }

  #[tokio::test]
  async fn warm_route_rejects_an_unknown_source_with_404() {
      let hits = Arc::new(AtomicUsize::new(0));
      let addr = spawn_stub(hits).await;
      let db = NamedTempFile::new().unwrap();
      let router = app(dev_state(&db));
      router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
      let warm = router.oneshot(
          Request::post("/warm").header("content-type", "application/json")
              .body(Body::from(r#"{"sources":["nope"],"bbox":[-1.0,-1.0,1.0,1.0],"minzoom":0,"maxzoom":0}"#)).unwrap()
      ).await.unwrap();
      assert_eq!(warm.status(), StatusCode::NOT_FOUND);
  }
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache routes::tests::warm_route`. Expected FAIL (no warm routes).
- [ ] Minimal implementation in `routes.rs`. Add the routes to `app`:
  ```rust
  .route("/warm", post(warm_start))
  .route("/warm/:job_id", get(warm_status))
  .route("/warm/:job_id/cancel", post(warm_cancel))
  ```
  Add the handler types and functions:
  ```rust
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct WarmBody {
      sources: Vec<String>,
      bbox: [f64; 4],
      minzoom: u32,
      maxzoom: u32,
  }

  async fn warm_start(State(st): State<AppState>, Json(body): Json<WarmBody>) -> Response {
      // Build the request from ids; start_warm resolves each id against the allowlist (the trusted config).
      let placeholders: Vec<crate::source::ChartSource> = body
          .sources
          .iter()
          .map(|id| crate::source::ChartSource {
              id: id.clone(), title: String::new(),
              upstream: crate::source::UpstreamTemplate::Xyz { url_template: String::new() },
              tile_size: 256, minzoom: body.minzoom, maxzoom: body.maxzoom, bounds: None, attribution: String::new(),
          })
          .collect();
      match crate::warm::start_warm(&st, crate::warm::WarmRequest { sources: placeholders, bbox: body.bbox, minzoom: body.minzoom, maxzoom: body.maxzoom }).await {
          Ok(job_id) => (StatusCode::OK, Json(serde_json::json!({ "jobId": job_id }))).into_response(),
          Err(crate::warm::StartError::UnknownSource(_)) => StatusCode::NOT_FOUND.into_response(),
          Err(crate::warm::StartError::TooMany(n)) => (StatusCode::BAD_REQUEST, format!("too many tiles: {n}")).into_response(),
          Err(crate::warm::StartError::BadBbox(m)) | Err(crate::warm::StartError::BadZoom(m)) => (StatusCode::BAD_REQUEST, m).into_response(),
      }
  }

  async fn warm_status(State(st): State<AppState>, Path(job_id): Path<String>) -> Response {
      match crate::warm::warm_snapshot(&st, &job_id).await {
          Some(snap) => Json(snap).into_response(),
          None => StatusCode::NOT_FOUND.into_response(),
      }
  }

  async fn warm_cancel(State(st): State<AppState>, Path(job_id): Path<String>) -> Response {
      if crate::warm::cancel_warm(&st, &job_id).await {
          StatusCode::NO_CONTENT.into_response()
      } else {
          StatusCode::NOT_FOUND.into_response()
      }
  }
  ```
  Note: `start_warm` resolves each id against `state.sources` and rejects an id absent or a style source, so the placeholder `ChartSource` carrying only the id is safe (its other fields are never used for the fetch; the resolved trusted config is). The `minzoom`/`maxzoom` carried on the placeholder are unused after resolution but make the projected-count path consistent.
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion/container && cargo test -p binnacle-tilecache routes`. Expected PASS. Then the full workspace gate: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo build --release --bin router` (and the tilecache binary). Expected PASS.
- [ ] Commit: `feat(tilecache): add POST /warm, GET /warm/:jobId, and cancel routes`

---

## Phase A: the plugin

### Task 8 [Phase A]: port the admin gate to the companion plugin

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/src/http/admin-gate.ts` (ported from `signalk-crows-nest/src/status/admin-gate.ts`, retargeted to this plugin id).
- Create `/home/dietpi/src/signalk-binnacle-companion/test/admin-gate.test.ts`.
- Reference: `/home/dietpi/src/signalk-binnacle-companion/src/shared/plugin-id.ts` for `PLUGIN_ID`.

**Interfaces:**
- Consumes: `ServerAPI` from `@signalk/server-api`, `PLUGIN_ID` from `../shared/plugin-id.js`.
- Produces: `export function ensureApiAdminGate (app: ServerAPI): boolean` (installs `securityStrategy.addAdminMiddleware('/plugins/<PLUGIN_ID>/api')` once per app, idempotent, fails closed).

Steps:

- [ ] Write the failing test. Create `test/admin-gate.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { ensureApiAdminGate } from '../src/http/admin-gate.js'
  import type { ServerAPI } from '@signalk/server-api'

  function fakeApp (withSecurity: boolean): { app: ServerAPI, gated: string[] } {
    const gated: string[] = []
    const app = {
      error: () => {},
      ...(withSecurity ? { securityStrategy: { addAdminMiddleware: (p: string) => gated.push(p) } } : {})
    } as unknown as ServerAPI
    return { app, gated }
  }

  test('the gate installs the admin middleware once and reports true', () => {
    const { app, gated } = fakeApp(true)
    assert.equal(ensureApiAdminGate(app), true)
    assert.equal(ensureApiAdminGate(app), true)
    assert.deepEqual(gated, ['/plugins/signalk-binnacle-companion/api'], 'installed exactly once')
  })

  test('the gate fails closed when no security strategy is present', () => {
    const { app } = fakeApp(false)
    assert.equal(ensureApiAdminGate(app), false)
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected FAIL (`src/http/admin-gate.ts` does not exist).
- [ ] Minimal implementation. Create `src/http/admin-gate.ts`:
  ```ts
  /**
   * Admin-gate the plugin's /api subtree, once per app. Plugin routers receive no authentication by
   * default, so every /api route sits behind the server's admin middleware. This helper installs that gate
   * exactly once per app and reports whether it is in place, so a caller mounts its route only when the gate
   * holds: a route that cannot be gated fails CLOSED (unmounted) rather than answering unauthenticated
   * callers. On an unsecured Signal K server every client is treated as admin, the standard Signal K behavior.
   */

  import type { ServerAPI } from '@signalk/server-api'
  import { PLUGIN_ID } from '../shared/plugin-id.js'

  /** Subtree to admin-gate, an absolute path under the mounted router. */
  const API_PATH = `/plugins/${PLUGIN_ID}/api`

  /** The slice of the server security strategy this module needs (not exposed on the ServerAPI type). */
  interface SecurityAwareApp {
    securityStrategy: {
      addAdminMiddleware: (path: string) => void
    }
  }

  /** Apps whose /api subtree has already been gated, keyed by the app object so it is installed once per app. */
  const gatedApps = new WeakSet<object>()

  /**
   * Ensure the plugin's /api subtree is admin-gated on `app`, and report whether the gate is in place.
   * Idempotent: installed on the first successful call; later calls return true without re-installing.
   * Returns false when the server exposes no admin middleware or the install throws, so the caller fails closed.
   */
  export function ensureApiAdminGate (app: ServerAPI): boolean {
    if (gatedApps.has(app)) return true
    try {
      const securityAware = app as unknown as Partial<SecurityAwareApp>
      if (typeof securityAware.securityStrategy?.addAdminMiddleware === 'function') {
        securityAware.securityStrategy.addAdminMiddleware(API_PATH)
        gatedApps.add(app)
        return true
      }
      app.error(`Cannot admin-gate ${API_PATH}: securityStrategy.addAdminMiddleware is unavailable`)
    } catch (error) {
      app.error(`Cannot admin-gate ${API_PATH}: ${String(error)}`)
    }
    return false
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected PASS. Then `npm run typecheck` and `npm run lint`. Expected PASS.
- [ ] Commit: `feat(companion): port the admin gate for the prewarm api subtree`

### Task 9 [Phase A]: plugin prewarm state persistence (the single source of truth)

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/src/runtime/prewarm-store.ts`.
- Create `/home/dietpi/src/signalk-binnacle-companion/test/prewarm-store.test.ts`.
- Reference pattern: `signalk-crows-nest/src/plugin/plugin.ts:286` persists JSON under `app.getDataDirPath()`.

**Interfaces:**
- Consumes: `app.getDataDirPath(): string` from `@signalk/server-api`, `node:fs`, `node:path`.
- Produces:
  - `export interface PositionWarmSettings { enabled: boolean, radiusMeters: number, moveThresholdMeters: number, intervalSecs: number, baseZoom: number, sources: string[] }`
  - `export interface PrewarmConfig { bbox: [number, number, number, number] | null, sources: string[], minzoom: number, maxzoom: number, positionWarm: PositionWarmSettings }`
  - `export const DEFAULT_PREWARM_CONFIG: PrewarmConfig`
  - `export function loadPrewarmConfig (dataDir: string): PrewarmConfig`
  - `export function savePrewarmConfig (dataDir: string, config: PrewarmConfig): void`

The spec calls this "the Signal K applicationData store". The typed server API exposes only `readPluginOptions`/`savePluginOptions` (which surface in the schema config screen, creating the second input surface the spec forbids) and `getDataDirPath()`. So persistence is a JSON state file under `getDataDirPath()`, mirroring how crows-nest persists its route-draft budget. This keeps the values out of `schema()` and out of `savePluginOptions`, exactly as the spec requires.

Steps:

- [ ] Write the failing test. Create `test/prewarm-store.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { mkdtempSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { loadPrewarmConfig, savePrewarmConfig, DEFAULT_PREWARM_CONFIG } from '../src/runtime/prewarm-store.js'

  test('loadPrewarmConfig returns the default when no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
    assert.deepEqual(loadPrewarmConfig(dir), DEFAULT_PREWARM_CONFIG)
  })

  test('saved config round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
    const cfg = { ...DEFAULT_PREWARM_CONFIG, bbox: [-10, 40, 10, 55] as [number, number, number, number], sources: ['seamark'], minzoom: 6, maxzoom: 10 }
    savePrewarmConfig(dir, cfg)
    assert.deepEqual(loadPrewarmConfig(dir), cfg)
  })

  test('a corrupt file falls back to the default rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
    require('node:fs').writeFileSync(join(dir, 'prewarm.json'), 'not json')
    assert.deepEqual(loadPrewarmConfig(dir), DEFAULT_PREWARM_CONFIG)
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected FAIL (`prewarm-store.ts` does not exist).
- [ ] Minimal implementation. Create `src/runtime/prewarm-store.ts`:
  ```ts
  /** Persists the prewarm box and the position-warm settings as a JSON state file under the Signal K data
   * directory. This is the single source of truth; the values are deliberately NOT in schema() or
   * savePluginOptions, so they never surface as a second input surface in the plugin config screen. */

  import { readFileSync, writeFileSync } from 'node:fs'
  import { join } from 'node:path'

  export interface PositionWarmSettings {
    enabled: boolean
    radiusMeters: number
    moveThresholdMeters: number
    intervalSecs: number
    baseZoom: number
    sources: string[]
  }

  export interface PrewarmConfig {
    bbox: [number, number, number, number] | null
    sources: string[]
    minzoom: number
    maxzoom: number
    positionWarm: PositionWarmSettings
  }

  /** Defaults: position-warm OFF (opt-in), a 2 nm radius, a 1 nm move threshold, a 60 s interval, base zoom 12. */
  export const DEFAULT_PREWARM_CONFIG: PrewarmConfig = {
    bbox: null,
    sources: [],
    minzoom: 6,
    maxzoom: 12,
    positionWarm: {
      enabled: false,
      radiusMeters: 3704,
      moveThresholdMeters: 1852,
      intervalSecs: 60,
      baseZoom: 12,
      sources: []
    }
  }

  const FILE = 'prewarm.json'

  /** Read the persisted config, falling back to the default on a missing or corrupt file. */
  export function loadPrewarmConfig (dataDir: string): PrewarmConfig {
    try {
      const raw = readFileSync(join(dataDir, FILE), 'utf8')
      const parsed = JSON.parse(raw) as Partial<PrewarmConfig>
      return {
        ...DEFAULT_PREWARM_CONFIG,
        ...parsed,
        positionWarm: { ...DEFAULT_PREWARM_CONFIG.positionWarm, ...(parsed.positionWarm ?? {}) }
      }
    } catch {
      return DEFAULT_PREWARM_CONFIG
    }
  }

  /** Write the config atomically enough for a single-writer plugin (one JSON file). */
  export function savePrewarmConfig (dataDir: string, config: PrewarmConfig): void {
    writeFileSync(join(dataDir, FILE), JSON.stringify(config, null, 2), 'utf8')
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected PASS. Then `npm run typecheck` and `npm run lint`. Expected PASS.
- [ ] Commit: `feat(companion): persist the prewarm box and settings under the data dir`

### Task 10 [Phase A]: plugin prewarm routes (admin-gated) and wiring

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/src/http/prewarm-routes.ts`.
- Create `/home/dietpi/src/signalk-binnacle-companion/test/prewarm-routes.test.ts`.
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/plugin/plugin.ts` (the `registerWithRouter` at lines 163-165, and pass `app.getDataDirPath()` plus the tilecache address getter).

**Interfaces:**
- Consumes: `ensureApiAdminGate` from `../http/admin-gate.js`, `loadPrewarmConfig`/`savePrewarmConfig`/`PrewarmConfig` from `../runtime/prewarm-store.js`, a tilecache address getter `() => string | null`, an injectable fetch.
- Produces: `export interface PrewarmRouter { get(path, handler); post(path, handler) }` (a structural subset of express), `export interface PrewarmRequest { params: Record<string, string>; body: unknown }`, `export interface PrewarmResponse { status(code): PrewarmResponse; json(value): void; end(): void }`, and `export function registerPrewarmRoutes (router: PrewarmRouter, app: ServerAPI, getAddress: () => string | null, deps?: { dataDir?: string, fetchImpl?: ProxyFetch }): boolean`.
- Routes mounted only when `ensureApiAdminGate(app)` is true (fail closed):
  - `POST /api/prewarm` body `{ bbox, sources, minzoom, maxzoom }`: persist the box, forward `POST /warm` to the container, return `{ jobId }`.
  - `GET /api/prewarm/status/:jobId`: proxy `GET /warm/:jobId`; a `404` from the container relays as `404`.
  - `POST /api/prewarm/cancel/:jobId`: proxy `POST /warm/:jobId/cancel`.
  - `GET|POST /api/prewarm/config`: read and write the persisted `PrewarmConfig`.
  - `GET /api/cache/stats`: proxy `GET /cache/stats`.

Steps:

- [ ] Write the failing test. Create `test/prewarm-routes.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { mkdtempSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { registerPrewarmRoutes, type PrewarmRouter, type PrewarmRequest, type PrewarmResponse } from '../src/http/prewarm-routes.js'
  import type { ServerAPI } from '@signalk/server-api'

  type Handler = (req: PrewarmRequest, res: PrewarmResponse) => void

  function collector () {
    const routes = new Map<string, Handler>()
    const router: PrewarmRouter = {
      get: (p, h) => routes.set(`GET ${p}`, h),
      post: (p, h) => routes.set(`POST ${p}`, h)
    }
    return { router, routes }
  }

  function fakeRes () {
    const out: { code: number, body?: unknown, ended: boolean } = { code: 200, ended: false }
    const res: PrewarmResponse = {
      status (c) { out.code = c; return res },
      json (v) { out.body = v },
      end () { out.ended = true }
    }
    return { res, out }
  }

  const securedApp = () => ({ error: () => {}, securityStrategy: { addAdminMiddleware: () => {} } } as unknown as ServerAPI)

  test('routes are not mounted without a security strategy (fail closed)', () => {
    const { router, routes } = collector()
    const app = { error: () => {} } as unknown as ServerAPI
    assert.equal(registerPrewarmRoutes(router, app, () => 'addr:8080'), false)
    assert.equal(routes.size, 0)
  })

  test('POST /api/prewarm persists the box and forwards to the container', async () => {
    const { router, routes } = collector()
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
    let posted: { url: string } | undefined
    const fetchImpl = async (url: string) => {
      posted = { url }
      return { ok: true, status: 200, json: async () => ({ jobId: 'warm-0' }), headers: new Headers(), body: null } as unknown as Response
    }
    assert.equal(registerPrewarmRoutes(router, securedApp(), () => 'addr:8080', { dataDir: dir, fetchImpl }), true)
    const { res, out } = fakeRes()
    await routes.get('POST /api/prewarm')!({ params: {}, body: { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 8 } }, res)
    assert.equal(posted?.url, 'http://addr:8080/warm')
    assert.deepEqual(out.body, { jobId: 'warm-0' })
    // The box is persisted as the source of truth.
    const { loadPrewarmConfig } = await import('../src/runtime/prewarm-store.js')
    assert.deepEqual(loadPrewarmConfig(dir).bbox, [-1, -1, 1, 1])
  })

  test('GET /api/prewarm/status relays a 404 as gone', async () => {
    const { router, routes } = collector()
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}), headers: new Headers(), body: null } as unknown as Response)
    registerPrewarmRoutes(router, securedApp(), () => 'addr:8080', { dataDir: mkdtempSync(join(tmpdir(), 'pw-')), fetchImpl })
    const { res, out } = fakeRes()
    await routes.get('GET /api/prewarm/status/:jobId')!({ params: { jobId: 'warm-9' }, body: undefined }, res)
    assert.equal(out.code, 404)
  })

  test('routes report 503 when the container address is unset', async () => {
    const { router, routes } = collector()
    registerPrewarmRoutes(router, securedApp(), () => null, { dataDir: mkdtempSync(join(tmpdir(), 'pw-')) })
    const { res, out } = fakeRes()
    await routes.get('GET /api/cache/stats')!({ params: {}, body: undefined }, res)
    assert.equal(out.code, 503)
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected FAIL (`prewarm-routes.ts` does not exist).
- [ ] Minimal implementation. Create `src/http/prewarm-routes.ts`:
  ```ts
  /** The admin-gated prewarm and config routes: the single write surface for the prewarm box. They persist
   * the box and the settings (the source of truth) and forward warm operations to the tilecache container.
   * Mounted only when the admin gate holds, so an ungatable server leaves them unmounted (fail closed). */

  import type { ServerAPI } from '@signalk/server-api'
  import { ensureApiAdminGate } from './admin-gate.js'
  import { loadPrewarmConfig, savePrewarmConfig, type PrewarmConfig } from '../runtime/prewarm-store.js'

  export interface PrewarmRequest {
    params: Record<string, string>
    body: unknown
  }

  export interface PrewarmResponse {
    status (code: number): PrewarmResponse
    json (value: unknown): void
    end (): void
  }

  export interface PrewarmRouter {
    get (path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void): void
    post (path: string, handler: (req: PrewarmRequest, res: PrewarmResponse) => void): void
  }

  type FetchImpl = (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<Response>

  interface Deps {
    dataDir?: string
    fetchImpl?: FetchImpl
  }

  /** Mount the prewarm routes behind the admin gate. Returns whether they were mounted. */
  export function registerPrewarmRoutes (router: PrewarmRouter, app: ServerAPI, getAddress: () => string | null, deps: Deps = {}): boolean {
    if (!ensureApiAdminGate(app)) return false
    const dataDir = deps.dataDir ?? app.getDataDirPath()
    const fetchImpl: FetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))

    const withAddress = (res: PrewarmResponse): string | null => {
      const address = getAddress()
      if (address === null) {
        res.status(503).end()
        return null
      }
      return address
    }

    const relay = async (res: PrewarmResponse, upstream: Promise<Response>): Promise<void> => {
      try {
        const r = await upstream
        const body = await r.json().catch(() => ({}))
        res.status(r.status).json(body)
      } catch {
        res.status(502).json({ error: 'tilecache unreachable' })
      }
    }

    router.post('/api/prewarm', (req, res) => {
      const address = withAddress(res); if (address === null) return
      const b = (req.body ?? {}) as Partial<PrewarmConfig>
      if (!Array.isArray(b.bbox) || b.bbox.length !== 4 || !Array.isArray(b.sources)) {
        res.status(400).json({ error: 'bbox and sources are required' }); return
      }
      const current = loadPrewarmConfig(dataDir)
      savePrewarmConfig(dataDir, { ...current, bbox: b.bbox as [number, number, number, number], sources: b.sources, minzoom: b.minzoom ?? current.minzoom, maxzoom: b.maxzoom ?? current.maxzoom })
      void relay(res, fetchImpl(`http://${address}/warm`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: b.sources, bbox: b.bbox, minzoom: b.minzoom ?? current.minzoom, maxzoom: b.maxzoom ?? current.maxzoom })
      }))
    })

    router.get('/api/prewarm/status/:jobId', (req, res) => {
      const address = withAddress(res); if (address === null) return
      void relay(res, fetchImpl(`http://${address}/warm/${encodeURIComponent(req.params.jobId)}`))
    })

    router.post('/api/prewarm/cancel/:jobId', (req, res) => {
      const address = withAddress(res); if (address === null) return
      void relay(res, fetchImpl(`http://${address}/warm/${encodeURIComponent(req.params.jobId)}/cancel`, { method: 'POST' }))
    })

    router.get('/api/prewarm/config', (_req, res) => {
      res.status(200).json(loadPrewarmConfig(dataDir))
    })

    router.post('/api/prewarm/config', (req, res) => {
      const current = loadPrewarmConfig(dataDir)
      const next = { ...current, ...(req.body as Partial<PrewarmConfig> ?? {}), positionWarm: { ...current.positionWarm, ...(((req.body as Partial<PrewarmConfig>)?.positionWarm) ?? {}) } }
      savePrewarmConfig(dataDir, next)
      res.status(204).end()
    })

    router.get('/api/cache/stats', (_req, res) => {
      const address = withAddress(res); if (address === null) return
      void relay(res, fetchImpl(`http://${address}/cache/stats`))
    })

    return true
  }
  ```
  Wire it in `plugin.ts`. Import at the top: `import { registerPrewarmRoutes, type PrewarmRouter } from '../http/prewarm-routes.js'`. Change `registerWithRouter` to also mount the prewarm routes (the tile routes stay open; the prewarm routes are gated):
  ```ts
  registerWithRouter (router) {
    registerTileRoutes(router as unknown as TileRouter, () => tilecacheAddress)
    registerPrewarmRoutes(router as unknown as PrewarmRouter, app, () => tilecacheAddress)
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected PASS. Then `npm run typecheck`, `npm run lint`, and `npm run build`. Expected PASS.
- [ ] Commit: `feat(companion): add admin-gated prewarm and config routes`

### Task 11 [Phase A]: pin the new tilecache image tag and bump the shared dependency

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/runtime/tilecache-container.ts` (`DEFAULT_TILECACHE_TAG`, line 11).
- Modify `/home/dietpi/src/signalk-binnacle-companion/package.json` and `/home/dietpi/src/signalk-binnacle/package.json` (the `signalk-binnacle-chart-sources` dependency range, after the package republish).

**Interfaces:**
- Consumes: the published v2 tilecache image and the published v2 `signalk-binnacle-chart-sources`.
- Produces: a pinned `DEFAULT_TILECACHE_TAG` and bumped dependency ranges.

This task has no unit test of its own (it is a build and release wiring step); its verification is the rebuilt image and the green plugin and webapp builds against the new package.

Steps:

- [ ] Build and publish the v2 `signalk-binnacle-chart-sources` to npm (this is already step 1 of the v1 release sequence). Move both consumers off the `file:` link to the published range.
- [ ] Rebuild and republish the tilecache image with the warm engine. Confirm the image builds (the container image build is part of the Task 7 gate).
- [ ] Pin the new tag: set `DEFAULT_TILECACHE_TAG` in `tilecache-container.ts` to the published immutable tag (a digest or a dated tag, not `latest`).
- [ ] Bump the `signalk-binnacle-chart-sources` dependency range in the plugin and the webapp `package.json`, refresh the lockfiles (`npm install`), and reinstall.
- [ ] Verify: `cd /home/dietpi/src/signalk-binnacle-companion && npm test && npm run build`, and `cd /home/dietpi/src/signalk-binnacle && npm run check && npm run build`. Expected PASS.
- [ ] Commit: `chore(companion): pin the v2 tilecache image tag and bump chart-sources`

---

## Phase A: the webapp

### Task 12 [Phase A]: webapp prewarm API client

**Files:**
- Create `/home/dietpi/src/signalk-binnacle/src/features/prewarm/prewarm-client.ts`.
- Create `/home/dietpi/src/signalk-binnacle/src/features/prewarm/prewarm-client.test.ts`.

**Interfaces:**
- Consumes: the plugin routes under `${origin}/plugins/signalk-binnacle-companion/api/...`, an injectable `fetch`.
- Produces:
  - `export interface WarmStatus { total: number, done: number, skipped: number, bytes: number, errors: number, state: 'running' | 'done' | 'cancelled' | 'capped' | 'error' }`
  - `export interface CacheStats { rows: number, bytes: number, cap: number, perSourceAvgBytes: Record<string, number> }`
  - `export interface PrewarmClient { postPrewarm; getStatus; cancel; getConfig; postConfig; getCacheStats }` with `getStatus` returning `WarmStatus | null` (null on a 404, the job is gone).
  - `export function createPrewarmClient (origin: string, fetchImpl?: typeof fetch): PrewarmClient`

Steps:

- [ ] Write the failing test. Create `prewarm-client.test.ts`:
  ```ts
  import { describe, it, expect, vi } from 'vitest'
  import { createPrewarmClient } from './prewarm-client.js'

  const ok = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body } as unknown as Response)

  describe('prewarm client', () => {
    it('posts a prewarm and returns the jobId', async () => {
      const fetchImpl = vi.fn(async () => ok({ jobId: 'warm-3' }))
      const client = createPrewarmClient('http://h', fetchImpl as unknown as typeof fetch)
      const res = await client.postPrewarm({ bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 8 })
      expect(res).toEqual({ jobId: 'warm-3' })
      expect(fetchImpl).toHaveBeenCalledWith('http://h/plugins/signalk-binnacle-companion/api/prewarm', expect.objectContaining({ method: 'POST' }))
    })

    it('maps a 404 status to null (the job is gone)', async () => {
      const fetchImpl = vi.fn(async () => ok({}, 404))
      const client = createPrewarmClient('http://h', fetchImpl as unknown as typeof fetch)
      expect(await client.getStatus('warm-9')).toBeNull()
    })

    it('reads the cache stats', async () => {
      const stats = { rows: 2, bytes: 100, cap: 1000, perSourceAvgBytes: { seamark: 50 } }
      const client = createPrewarmClient('http://h', (async () => ok(stats)) as unknown as typeof fetch)
      expect(await client.getCacheStats()).toEqual(stats)
    })
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/prewarm-client.test.ts`. Expected FAIL (module does not exist).
- [ ] Minimal implementation. Create `prewarm-client.ts`:
  ```ts
  /** The webapp client for the companion prewarm and config routes. The panel never calls the container
   * directly; it always goes through the admin-gated plugin routes, so the container port stays private. */

  const API = '/plugins/signalk-binnacle-companion/api'

  export interface WarmStatus {
    total: number
    done: number
    skipped: number
    bytes: number
    errors: number
    state: 'running' | 'done' | 'cancelled' | 'capped' | 'error'
  }

  export interface CacheStats {
    rows: number
    bytes: number
    cap: number
    perSourceAvgBytes: Record<string, number>
  }

  export interface PrewarmRequestBody {
    bbox: [number, number, number, number]
    sources: string[]
    minzoom: number
    maxzoom: number
  }

  export interface PrewarmClient {
    postPrewarm (body: PrewarmRequestBody): Promise<{ jobId: string }>
    getStatus (jobId: string): Promise<WarmStatus | null>
    cancel (jobId: string): Promise<void>
    getConfig (): Promise<unknown>
    postConfig (config: unknown): Promise<void>
    getCacheStats (): Promise<CacheStats>
  }

  export function createPrewarmClient (origin: string, fetchImpl: typeof fetch = fetch): PrewarmClient {
    const url = (path: string): string => `${origin}${API}${path}`
    const json = async <T>(r: Response): Promise<T> => (await r.json()) as T
    return {
      async postPrewarm (body) {
        const r = await fetchImpl(url('/prewarm'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
        return json<{ jobId: string }>(r)
      },
      async getStatus (jobId) {
        const r = await fetchImpl(url(`/prewarm/status/${encodeURIComponent(jobId)}`), { credentials: 'same-origin' })
        if (r.status === 404) return null
        return json<WarmStatus>(r)
      },
      async cancel (jobId) {
        await fetchImpl(url(`/prewarm/cancel/${encodeURIComponent(jobId)}`), { method: 'POST', credentials: 'same-origin' })
      },
      async getConfig () {
        return json(await fetchImpl(url('/prewarm/config'), { credentials: 'same-origin' }))
      },
      async postConfig (config) {
        await fetchImpl(url('/prewarm/config'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config), credentials: 'same-origin' })
      },
      async getCacheStats () {
        return json<CacheStats>(await fetchImpl(url('/cache/stats'), { credentials: 'same-origin' }))
      }
    }
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/prewarm-client.test.ts`. Expected PASS.
- [ ] Commit: `feat(binnacle): add the prewarm api client`

### Task 13 [Phase A]: webapp estimate and draw-to-bbox logic (pure)

**Files:**
- Create `/home/dietpi/src/signalk-binnacle/src/features/prewarm/estimate.ts`.
- Create `/home/dietpi/src/signalk-binnacle/src/features/prewarm/estimate.test.ts`.

**Interfaces:**
- Consumes: `tileCountInBbox`, `CHART_SOURCES`, and `ChartSource` from `signalk-binnacle-chart-sources`; `CacheStats` from `./prewarm-client.js`.
- Produces:
  - `export const DEFAULT_TILE_BYTES = 25_000`
  - `export function prewarmableSources (): ChartSource[]` (the registry minus `style` sources, which have no tile path)
  - `export function estimateBytes (sourceIds: string[], bbox: [number, number, number, number], zoomRange: [number, number], stats: CacheStats): number`
  - `export function freeCapBytes (stats: CacheStats): number`
  - `export function exceedsFreeCap (estimate: number, stats: CacheStats): boolean`
  - `export function bboxFromRectangle (ring: Array<[number, number]>): [number, number, number, number]`

Steps:

- [ ] Write the failing test. Create `estimate.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { estimateBytes, freeCapBytes, exceedsFreeCap, bboxFromRectangle, prewarmableSources, DEFAULT_TILE_BYTES } from './estimate.js'
  import type { CacheStats } from './prewarm-client.js'

  const stats = (over: Partial<CacheStats> = {}): CacheStats => ({ rows: 0, bytes: 0, cap: 1_000_000_000, perSourceAvgBytes: {}, ...over })

  describe('prewarm estimate', () => {
    it('excludes style sources from the prewarmable list', () => {
      expect(prewarmableSources().some((s) => s.upstream.mode === 'style')).toBe(false)
      expect(prewarmableSources().some((s) => s.id === 'seamark')).toBe(true)
    })

    it('uses the per-source average when present, the default otherwise', () => {
      const bbox: [number, number, number, number] = [-1, -1, 1, 1]
      const withAvg = estimateBytes(['seamark'], bbox, [6, 6], stats({ perSourceAvgBytes: { seamark: 100 } }))
      const withDefault = estimateBytes(['seamark'], bbox, [6, 6], stats())
      expect(withAvg).toBeGreaterThan(0)
      expect(withDefault).toBeGreaterThan(0)
      expect(withDefault % DEFAULT_TILE_BYTES).toBe(0)
    })

    it('the free cap is the cap minus the used bytes', () => {
      expect(freeCapBytes(stats({ cap: 1000, bytes: 400 }))).toBe(600)
    })

    it('flags an estimate over the free cap', () => {
      expect(exceedsFreeCap(700, stats({ cap: 1000, bytes: 400 }))).toBe(true)
      expect(exceedsFreeCap(500, stats({ cap: 1000, bytes: 400 }))).toBe(false)
    })

    it('derives a bbox from a drawn rectangle ring', () => {
      const ring: Array<[number, number]> = [[10, 50], [20, 50], [20, 55], [10, 55], [10, 50]]
      expect(bboxFromRectangle(ring)).toEqual([10, 50, 20, 55])
    })
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/estimate.test.ts`. Expected FAIL.
- [ ] Minimal implementation. Create `estimate.ts`:
  ```ts
  /** Pure estimate helpers for the prewarm panel: project the tile count with the shared enumerator and
   * multiply by the per-source byte average from the cache stats, gated against the free cap. The estimate
   * is a ceiling (a warm negative-caches 404s at zero bytes, so the real footprint is smaller). */

  import { CHART_SOURCES, tileCountInBbox, type ChartSource } from 'signalk-binnacle-chart-sources'
  import type { CacheStats } from './prewarm-client.js'

  /** Fallback per-tile size for a source never cached yet, so the estimate still gates a first prewarm. */
  export const DEFAULT_TILE_BYTES = 25_000

  /** The registry sources that have a tile path; the style basemap is excluded (its warm path differs and is out of scope). */
  export function prewarmableSources (): ChartSource[] {
    return CHART_SOURCES.filter((s) => s.upstream.mode !== 'style')
  }

  const byId = new Map(CHART_SOURCES.map((s) => [s.id, s]))

  /** The upper-bound byte estimate: sum over sources of tileCountInBbox times the per-source average. */
  export function estimateBytes (sourceIds: string[], bbox: [number, number, number, number], zoomRange: [number, number], stats: CacheStats): number {
    let total = 0
    for (const id of sourceIds) {
      const source = byId.get(id)
      if (!source) continue
      const tiles = tileCountInBbox(source, bbox, zoomRange)
      const avg = stats.perSourceAvgBytes[id] ?? DEFAULT_TILE_BYTES
      total += tiles * avg
    }
    return total
  }

  /** The bytes still available under the cap. */
  export function freeCapBytes (stats: CacheStats): number {
    return Math.max(0, stats.cap - stats.bytes)
  }

  /** Whether the estimate would exceed the free cap (Prewarm is disabled while true). */
  export function exceedsFreeCap (estimate: number, stats: CacheStats): boolean {
    return estimate > freeCapBytes(stats)
  }

  /** The [minLng, minLat, maxLng, maxLat] of a drawn rectangle ring of [lng, lat] points. */
  export function bboxFromRectangle (ring: Array<[number, number]>): [number, number, number, number] {
    const lngs = ring.map((p) => p[0])
    const lats = ring.map((p) => p[1])
    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/estimate.test.ts`. Expected PASS.
- [ ] Commit: `feat(binnacle): add prewarm estimate and draw-to-bbox helpers`

### Task 14 [Phase A]: webapp prewarm panel

Design the panel with the UI/UX team (`signalk-ui-designer` plus a second reviewer) before building, kept consistent with the existing `signalk-binnacle` panels: the same control primitives, design tokens, themes, section layout, label voice, and spacing, in the existing SlideOver shell. Reuse the existing control primitive for any field an existing one already covers; never introduce a one-off.

**Files:**
- Create `/home/dietpi/src/signalk-binnacle/src/features/prewarm/PrewarmPanel.svelte`.
- Create `/home/dietpi/src/signalk-binnacle/src/features/prewarm/prewarm-panel.svelte.test.ts`.
- Create `/home/dietpi/src/signalk-binnacle/src/features/prewarm/prewarm-draw.ts` (the panel-scoped Terra Draw rectangle instance).
- Reference primitives: `src/shared/ui/SlideOver.svelte`, `src/shared/ui/UnitField.svelte`, `src/features/layers-panel/LayerToggle.svelte`, `src/styles/buttons.css`, `src/styles/tokens.css`, `src/shared/map/companion.ts` (`detectCompanion`), `src/shared/signalk/auth.svelte.ts` (`writeBlocked`), `src/entities/units/units.svelte.ts` (the units store), `src/features/route-edit/route-edit.ts` (the Terra Draw construction pattern).

**Interfaces:**
- Consumes: `createPrewarmClient` and `CacheStats`/`WarmStatus` from `./prewarm-client.js`; `estimateBytes`, `exceedsFreeCap`, `freeCapBytes`, `prewarmableSources`, `bboxFromRectangle` from `./estimate.js`; `detectCompanion` from `../../shared/map/companion.js`; the auth controller exposing `writeBlocked`; the units store; the shared `MapLibreMap` instance.
- Produces: a feature-detected, write-token-gated prewarm panel and a `prewarm-draw.ts` module:
  - `export function createPrewarmRectangle (map: MapLibreMap): { start(): void, clear(): void, onChange(cb: (bbox: [number, number, number, number] | null) => void): void, destroy(): void }`

Steps:

- [ ] Write the failing test for the panel-scoped draw module and the estimate-gate wiring. Create `prewarm-panel.svelte.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { estimateBytes, exceedsFreeCap } from './estimate.js'
  import type { CacheStats } from './prewarm-client.js'

  // The panel's Prewarm button is enabled only when a box is drawn, at least one source is selected, the
  // user can write, and the estimate fits the free cap. This test pins the gate predicate the panel uses.
  function canPrewarm (opts: { bbox: [number, number, number, number] | null, sources: string[], writeBlocked: boolean, stats: CacheStats, zoomRange: [number, number] }): boolean {
    if (opts.bbox === null || opts.sources.length === 0 || opts.writeBlocked) return false
    return !exceedsFreeCap(estimateBytes(opts.sources, opts.bbox, opts.zoomRange, opts.stats), opts.stats)
  }

  const stats: CacheStats = { rows: 0, bytes: 0, cap: 1_000_000_000, perSourceAvgBytes: { seamark: 20_000 } }

  describe('prewarm gate', () => {
    it('disabled with no box', () => {
      expect(canPrewarm({ bbox: null, sources: ['seamark'], writeBlocked: false, stats, zoomRange: [6, 8] })).toBe(false)
    })
    it('disabled when write is blocked', () => {
      expect(canPrewarm({ bbox: [-1, -1, 1, 1], sources: ['seamark'], writeBlocked: true, stats, zoomRange: [6, 8] })).toBe(false)
    })
    it('disabled when the estimate exceeds the free cap', () => {
      const tiny: CacheStats = { ...stats, cap: 1000, bytes: 0 }
      expect(canPrewarm({ bbox: [-5, -5, 5, 5], sources: ['seamark'], writeBlocked: false, stats: tiny, zoomRange: [6, 10] })).toBe(false)
    })
    it('enabled when a box and a source are set and the estimate fits', () => {
      expect(canPrewarm({ bbox: [-0.1, -0.1, 0.1, 0.1], sources: ['seamark'], writeBlocked: false, stats, zoomRange: [6, 7] })).toBe(true)
    })
  })
  ```
  (The panel imports the same `canPrewarm` predicate from `estimate.ts`; promote it there so the test and the panel share one definition. Add `export function canPrewarm (...)` to `estimate.ts` with this body and import it in both.)
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/prewarm-panel.svelte.test.ts`. Expected FAIL (`canPrewarm` is not exported).
- [ ] Minimal implementation, part 1: add `canPrewarm` to `estimate.ts`:
  ```ts
  import type { WarmStatus } from './prewarm-client.js'

  /** The single gate predicate shared by the panel and its test. */
  export function canPrewarm (opts: { bbox: [number, number, number, number] | null, sources: string[], writeBlocked: boolean, stats: CacheStats, zoomRange: [number, number] }): boolean {
    if (opts.bbox === null || opts.sources.length === 0 || opts.writeBlocked) return false
    return !exceedsFreeCap(estimateBytes(opts.sources, opts.bbox, opts.zoomRange, opts.stats), opts.stats)
  }

  /** A poll status is terminal when the job is no longer running. A null status means the job is gone (re-warm). */
  export function isTerminal (status: WarmStatus | null): boolean {
    return status === null || status.state !== 'running'
  }
  ```
- [ ] Minimal implementation, part 2: create `prewarm-draw.ts`, a panel-scoped Terra Draw rectangle instance (a second instance from the route editor's, so it does not conflict). Mirror the construction at `route-edit.ts:88`:
  ```ts
  /** A panel-scoped Terra Draw instance with only the rectangle mode, separate from the route editor's
   * instance so the two never conflict. Emits the drawn box as a [minLng, minLat, maxLng, maxLat]. */

  import { TerraDraw, TerraDrawRectangleMode } from 'terra-draw'
  import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
  import type { Map as MapLibreMap } from 'maplibre-gl'
  import { bboxFromRectangle } from './estimate.js'

  export interface PrewarmRectangle {
    start (): void
    clear (): void
    onChange (cb: (bbox: [number, number, number, number] | null) => void): void
    destroy (): void
  }

  export function createPrewarmRectangle (map: MapLibreMap): PrewarmRectangle {
    const draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, prefixId: 'binnacle-prewarm-draw' }),
      modes: [new TerraDrawRectangleMode()]
    })
    let onChangeCb: (bbox: [number, number, number, number] | null) => void = () => {}
    draw.on('finish', () => {
      const snapshot = draw.getSnapshot()
      const polygon = snapshot.find((f) => f.geometry.type === 'Polygon')
      if (!polygon) { onChangeCb(null); return }
      const ring = (polygon.geometry.coordinates as number[][][])[0].map((p) => [p[0], p[1]] as [number, number])
      onChangeCb(bboxFromRectangle(ring))
    })
    return {
      start () { draw.start(); draw.setMode('rectangle') },
      clear () { draw.clear(); onChangeCb(null) },
      onChange (cb) { onChangeCb = cb },
      destroy () { draw.stop() }
    }
  }
  ```
- [ ] Minimal implementation, part 3: build `PrewarmPanel.svelte` in the SlideOver shell, Svelte 5 runes. The component:
  - Mounts only when `detectCompanion(location.origin)` resolves non-null (feature-detect); otherwise renders nothing.
  - Reads `auth.writeBlocked`; when true, shows the controls read-only with a note that a write token is needed (the server-side admin gate is the authority; this only avoids showing a control that will 401).
  - Lists `prewarmableSources()` as checkboxes (reuse `LayerToggle` or the shared checkbox primitive; do not introduce a one-off).
  - Zoom min and max controls using the shared number primitive.
  - A "Draw box" button calling `createPrewarmRectangle(map).start()`, and a "Clear" button calling `.clear()`.
  - Loads `getCacheStats()` on open and shows the live estimate through `UnitField` for the byte estimate (humanized), against `freeCapBytes`; the Prewarm button is disabled while `canPrewarm(...)` is false, with copy that the estimate is a ceiling.
  - On Prewarm: `postPrewarm({ bbox, sources, minzoom, maxzoom })`, then poll `getStatus(jobId)` on an interval, show a progress bar from `done / total`, offer Cancel, and on a null status (the container restarted and lost the in-memory job) treat the job as gone and offer a re-warm, using `isTerminal`.
  - The unit-bearing byte estimate goes through `UnitField`; in phase B the radius and the move threshold also go through `UnitField` reading the server length preference (never a hardcoded nautical-mile unit and never a panel-local toggle).
  - Use design tokens for spacing and color (`--space-*`, `--accent`, and the others in `tokens.css`); add any panel styles as a small focused module imported through the `app.css` manifest, never a monolith.
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/prewarm-panel.svelte.test.ts`. Expected PASS. Then `npm run check`, `npm run lint`, and `npm run build`. Expected PASS. Note: the live Terra Draw rectangle interaction and the offline render are boat and manual tested (section 9 boat-only items); the unit tests cover the gate predicate, the estimate, the draw-to-bbox conversion, the client, and the feature-detect hide.
- [ ] Commit: `feat(binnacle): add the prewarm panel with the estimate gate and box draw`

---

## Phase B: off-plan position-warm

### Task 15 [Phase B]: plugin position-warm decision logic (pure)

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/src/runtime/position-warm.ts`.
- Create `/home/dietpi/src/signalk-binnacle-companion/test/position-warm.test.ts`.

**Interfaces:**
- Consumes: `Position` from `../shared/types.js`, `PositionWarmSettings` from `./prewarm-store.js`.
- Produces:
  - `export interface WarmTrigger { lastPos: Position | null, lastWarmMs: number, backoffUntilMs: number }`
  - `export function insideBox (pos: Position, bbox: [number, number, number, number] | null): boolean`
  - `export function haversineMeters (a: Position, b: Position): number`
  - `export function bboxAround (pos: Position, radiusMeters: number): [number, number, number, number]`
  - `export function shouldWarm (pos: Position, box: [number, number, number, number] | null, settings: PositionWarmSettings, trigger: WarmTrigger, nowMs: number): boolean`

The throttle, the outside-box trigger, the move threshold, and the all-errors backoff are all pure decisions here, so they are unit tested without timers or a network.

Steps:

- [ ] Write the failing test. Create `test/position-warm.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { insideBox, haversineMeters, bboxAround, shouldWarm, type WarmTrigger } from '../src/runtime/position-warm.js'
  import { DEFAULT_PREWARM_CONFIG } from '../src/runtime/prewarm-store.js'

  const here = { latitude: 37.8, longitude: -122.4 }
  const settings = { ...DEFAULT_PREWARM_CONFIG.positionWarm, enabled: true, sources: ['seamark'] }
  const fresh: WarmTrigger = { lastPos: null, lastWarmMs: 0, backoffUntilMs: 0 }

  test('insideBox is true only within the box', () => {
    assert.equal(insideBox(here, [-123, 37, -122, 38]), true)
    assert.equal(insideBox(here, [-122, 37, -121, 38]), false)
    assert.equal(insideBox(here, null), false)
  })

  test('haversine is roughly a nautical mile for a minute of latitude', () => {
    const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1 / 60, longitude: 0 })
    assert.ok(Math.abs(d - 1852) < 5)
  })

  test('bboxAround brackets the position', () => {
    const [minLng, minLat, maxLng, maxLat] = bboxAround(here, 1852)
    assert.ok(minLng < here.longitude && maxLng > here.longitude)
    assert.ok(minLat < here.latitude && maxLat > here.latitude)
  })

  test('shouldWarm fires outside the box after the move threshold and interval', () => {
    // first fix, outside the box, no prior warm: fires.
    assert.equal(shouldWarm(here, [-122, 37, -121, 38], settings, fresh, 1_000_000), true)
  })

  test('shouldWarm is false inside the box', () => {
    assert.equal(shouldWarm(here, [-123, 37, -122, 38], settings, fresh, 1_000_000), false)
  })

  test('shouldWarm respects the interval and the move threshold', () => {
    const recent: WarmTrigger = { lastPos: here, lastWarmMs: 1_000_000, backoffUntilMs: 0 }
    // same spot, 30 s later: under the 60 s interval, no warm.
    assert.equal(shouldWarm(here, [-122, 37, -121, 38], settings, recent, 1_030_000), false)
    // 90 s later but barely moved: under the move threshold, no warm.
    assert.equal(shouldWarm({ latitude: 37.8001, longitude: -122.4 }, [-122, 37, -121, 38], settings, recent, 1_090_000), false)
  })

  test('shouldWarm backs off after an all-errors warm', () => {
    const backed: WarmTrigger = { lastPos: null, lastWarmMs: 0, backoffUntilMs: 2_000_000 }
    assert.equal(shouldWarm(here, [-122, 37, -121, 38], settings, backed, 1_500_000), false)
    assert.equal(shouldWarm(here, [-122, 37, -121, 38], settings, backed, 2_500_000), true)
  })

  test('shouldWarm is false when disabled', () => {
    assert.equal(shouldWarm(here, [-122, 37, -121, 38], { ...settings, enabled: false }, fresh, 1_000_000), false)
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected FAIL (module does not exist).
- [ ] Minimal implementation. Create `src/runtime/position-warm.ts`:
  ```ts
  /** Pure decision logic for the off-plan position-warm: when the vessel travels outside the prewarmed box,
   * keep a small radius around it warm, throttled and offline-aware. The Signal K read stays in the plugin;
   * this module decides, the caller performs the warm. */

  import type { Position } from '../shared/types.js'
  import type { PositionWarmSettings } from './prewarm-store.js'

  export interface WarmTrigger {
    lastPos: Position | null
    lastWarmMs: number
    backoffUntilMs: number
  }

  /** Whether the position is within the box (a null box is never inside). */
  export function insideBox (pos: Position, bbox: [number, number, number, number] | null): boolean {
    if (bbox === null) return false
    return pos.longitude >= bbox[0] && pos.longitude <= bbox[2] && pos.latitude >= bbox[1] && pos.latitude <= bbox[3]
  }

  const EARTH_RADIUS_M = 6_371_000

  /** Great-circle distance in meters. */
  export function haversineMeters (a: Position, b: Position): number {
    const toRad = (d: number): number => (d * Math.PI) / 180
    const dLat = toRad(b.latitude - a.latitude)
    const dLng = toRad(b.longitude - a.longitude)
    const lat1 = toRad(a.latitude)
    const lat2 = toRad(b.latitude)
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
  }

  /** A small bbox of `radiusMeters` around the position. Longitude degrees shrink with latitude. */
  export function bboxAround (pos: Position, radiusMeters: number): [number, number, number, number] {
    const dLat = radiusMeters / 111_320
    const dLng = radiusMeters / (111_320 * Math.max(0.01, Math.cos((pos.latitude * Math.PI) / 180)))
    return [pos.longitude - dLng, pos.latitude - dLat, pos.longitude + dLng, pos.latitude + dLat]
  }

  /** Decide whether to warm now: enabled, outside the box, off backoff, past the interval, and moved past the threshold. */
  export function shouldWarm (pos: Position, box: [number, number, number, number] | null, settings: PositionWarmSettings, trigger: WarmTrigger, nowMs: number): boolean {
    if (!settings.enabled) return false
    if (insideBox(pos, box)) return false
    if (nowMs < trigger.backoffUntilMs) return false
    if (trigger.lastPos !== null) {
      if (nowMs - trigger.lastWarmMs < settings.intervalSecs * 1000) return false
      if (haversineMeters(pos, trigger.lastPos) < settings.moveThresholdMeters) return false
    }
    return true
  }
  ```
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected PASS. Then `npm run typecheck` and `npm run lint`. Expected PASS.
- [ ] Commit: `feat(companion): add position-warm decision logic`

### Task 16 [Phase B]: wire the position-warm loop into the plugin lifecycle

**Files:**
- Create `/home/dietpi/src/signalk-binnacle-companion/src/runtime/position-warmer.ts` (the stateful loop binding the decision logic to the container warm and the navigation.position stream).
- Create `/home/dietpi/src/signalk-binnacle-companion/test/position-warmer.test.ts`.
- Modify `/home/dietpi/src/signalk-binnacle-companion/src/plugin/plugin.ts` (subscribe in `doStart` after the tilecache address resolves, unsubscribe in `doStop`).

**Interfaces:**
- Consumes: `shouldWarm`, `bboxAround`, `WarmTrigger` from `./position-warm.js`; `loadPrewarmConfig` from `./prewarm-store.js`; a warm poster `(bbox, sources, minzoom, maxzoom) => Promise<WarmStatus | null>`; a clock `() => number`.
- Produces:
  - `export interface PositionWarmer { onPosition (pos: Position): void }`
  - `export function createPositionWarmer (deps: { getConfig: () => PrewarmConfig, warm: (bbox: [number, number, number, number], sources: string[], minzoom: number, maxzoom: number) => Promise<{ errors: number, total: number } | null>, now?: () => number, backoffSecs?: number }): PositionWarmer`
- Subscription in `plugin.ts`: `const unsub = app.streambundle.getSelfBus('navigation.position').onValue((d) => warmer.onPosition(d.value as Position))`, stored and called in `doStop` (the crows-nest pattern at `position-monitor.ts:239` and `:251`).

Steps:

- [ ] Write the failing test. Create `test/position-warmer.test.ts`:
  ```ts
  import { test } from 'node:test'
  import assert from 'node:assert/strict'
  import { createPositionWarmer } from '../src/runtime/position-warmer.js'
  import { DEFAULT_PREWARM_CONFIG } from '../src/runtime/prewarm-store.js'

  function config (over = {}) {
    return { ...DEFAULT_PREWARM_CONFIG, bbox: [-123, 37, -122, 38] as [number, number, number, number], positionWarm: { ...DEFAULT_PREWARM_CONFIG.positionWarm, enabled: true, sources: ['seamark'], ...over } }
  }

  test('warms once outside the box, then respects the interval', async () => {
    let clock = 1_000_000
    const warmed: Array<[number, number, number, number]> = []
    const warmer = createPositionWarmer({
      getConfig: () => config(),
      warm: async (bbox) => { warmed.push(bbox); return { errors: 0, total: 4 } },
      now: () => clock
    })
    warmer.onPosition({ latitude: 37.5, longitude: -121.5 }) // outside the box
    await Promise.resolve()
    assert.equal(warmed.length, 1)
    clock += 30_000
    warmer.onPosition({ latitude: 37.5, longitude: -121.5 }) // under the interval
    await Promise.resolve()
    assert.equal(warmed.length, 1)
  })

  test('does not warm inside the box', async () => {
    const warmed: unknown[] = []
    const warmer = createPositionWarmer({ getConfig: () => config(), warm: async (b) => { warmed.push(b); return { errors: 0, total: 1 } }, now: () => 1_000_000 })
    warmer.onPosition({ latitude: 37.5, longitude: -122.5 }) // inside
    await Promise.resolve()
    assert.equal(warmed.length, 0)
  })

  test('backs off after an all-errors warm', async () => {
    let clock = 1_000_000
    let calls = 0
    const warmer = createPositionWarmer({
      getConfig: () => config(),
      warm: async () => { calls++; return { errors: 16, total: 16 } }, // all errors: offline
      now: () => clock,
      backoffSecs: 600
    })
    warmer.onPosition({ latitude: 37.5, longitude: -121.5 })
    await Promise.resolve()
    assert.equal(calls, 1)
    clock += 120_000 // 2 min later, well past the interval, but inside the 10 min backoff
    warmer.onPosition({ latitude: 38.5, longitude: -120.5 })
    await Promise.resolve()
    assert.equal(calls, 1, 'still backed off')
    clock += 600_000
    warmer.onPosition({ latitude: 39.5, longitude: -119.5 })
    await Promise.resolve()
    assert.equal(calls, 2, 'resumes after the backoff')
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected FAIL.
- [ ] Minimal implementation. Create `src/runtime/position-warmer.ts`:
  ```ts
  /** The stateful position-warm loop: on each navigation.position fix it decides (via shouldWarm) whether to
   * warm a small radius around the vessel, throttles, and backs off when a warm returns all-errors (an
   * offline passage), so it does not fire roughly 16 fetches each blocking on the egress timeout every
   * interval. The container being healthy only means the container is up, not that the internet is up. */

  import type { Position } from '../shared/types.js'
  import type { PrewarmConfig } from './prewarm-store.js'
  import { shouldWarm, bboxAround, type WarmTrigger } from './position-warm.js'

  export interface PositionWarmer {
    onPosition (pos: Position): void
  }

  interface Deps {
    getConfig: () => PrewarmConfig
    warm: (bbox: [number, number, number, number], sources: string[], minzoom: number, maxzoom: number) => Promise<{ errors: number, total: number } | null>
    now?: () => number
    backoffSecs?: number
  }

  /** A small zoom window around the configured base, capped to keep the warm at about 16 tiles. */
  const ZOOM_SPREAD = 1
  const DEFAULT_BACKOFF_SECS = 600

  export function createPositionWarmer (deps: Deps): PositionWarmer {
    const now = deps.now ?? Date.now
    const backoffSecs = deps.backoffSecs ?? DEFAULT_BACKOFF_SECS
    const trigger: WarmTrigger = { lastPos: null, lastWarmMs: 0, backoffUntilMs: 0 }
    let inFlight = false

    return {
      onPosition (pos: Position): void {
        if (inFlight) return
        const config = deps.getConfig()
        const settings = config.positionWarm
        const nowMs = now()
        if (!shouldWarm(pos, config.bbox, settings, trigger, nowMs)) return
        const bbox = bboxAround(pos, settings.radiusMeters)
        const minzoom = Math.max(0, settings.baseZoom - ZOOM_SPREAD)
        const maxzoom = settings.baseZoom + ZOOM_SPREAD
        inFlight = true
        trigger.lastPos = pos
        trigger.lastWarmMs = nowMs
        void deps.warm(bbox, settings.sources, minzoom, maxzoom).then((result) => {
          // All-errors (and a non-zero attempt) means offline: back off so we do not hammer the egress timeout.
          if (result !== null && result.total > 0 && result.errors >= result.total) {
            trigger.backoffUntilMs = now() + backoffSecs * 1000
          } else if (result === null) {
            trigger.backoffUntilMs = now() + backoffSecs * 1000
          }
        }).catch(() => {
          trigger.backoffUntilMs = now() + backoffSecs * 1000
        }).finally(() => {
          inFlight = false
        })
      }
    }
  }
  ```
  Wire it into `plugin.ts`. Add a module-level `let positionUnsub: (() => void) | null = null` and a `let warmer: PositionWarmer | null = null`. After the tilecache address resolves in `doStart`, build the warmer and subscribe:
  ```ts
  warmer = createPositionWarmer({
    getConfig: () => loadPrewarmConfig(app.getDataDirPath()),
    warm: async (bbox, sources, minzoom, maxzoom) => {
      const address = tilecacheAddress
      if (address === null) return null
      try {
        const start = await fetch(`http://${address}/warm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources, bbox, minzoom, maxzoom }) })
        if (!start.ok) return null
        const { jobId } = await start.json() as { jobId: string }
        // Poll briefly to learn whether it was all-errors (offline) for the backoff decision.
        for (let i = 0; i < 20; i++) {
          const s = await fetch(`http://${address}/warm/${jobId}`)
          if (s.status === 404) return null
          const snap = await s.json() as { errors: number, total: number, state: string }
          if (snap.state !== 'running') return { errors: snap.errors, total: snap.total }
          await new Promise((r) => setTimeout(r, 500))
        }
        return null
      } catch {
        return null
      }
    }
  })
  positionUnsub = app.streambundle.getSelfBus('navigation.position' as unknown as Parameters<typeof app.streambundle.getSelfBus>[0])
    .onValue((delta: { value: unknown }) => { if (warmer) warmer.onPosition(delta.value as Position) })
  ```
  In `doStop`, unsubscribe first: `if (positionUnsub) { positionUnsub(); positionUnsub = null }` and `warmer = null`. Import `createPositionWarmer`, `loadPrewarmConfig`, and the `Position` type.
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle-companion && npm test`. Expected PASS. Then `npm run typecheck`, `npm run lint`, and `npm run build`. Expected PASS.
- [ ] Add a `doStop` unsubscribe test. Extend `test/plugin.test.ts` (or `plugin-integration.test.ts`) so the fake `app.streambundle.getSelfBus` returns a spy unsubscribe and assert it is called on stop. Run `npm test`. Expected PASS.
- [ ] Commit: `feat(companion): run the off-plan position-warm loop with offline backoff`

### Task 17 [Phase B]: webapp position-warm settings

**Files:**
- Modify `/home/dietpi/src/signalk-binnacle/src/features/prewarm/PrewarmPanel.svelte` (add the position-warm section).
- Modify `/home/dietpi/src/signalk-binnacle/src/features/prewarm/prewarm-panel.svelte.test.ts` (add the settings persistence test).

**Interfaces:**
- Consumes: `getConfig`/`postConfig` from the prewarm client; `UnitField` for the radius and the move threshold (reading the server length preference); the shared toggle and number primitives.
- Produces: a position-warm section in the panel: an enable toggle, the radius and the move threshold (through `UnitField`, server length units), the interval and the base zoom, and the source selection, all persisted via `POST /api/prewarm/config`.

Steps:

- [ ] Write the failing test. Add to `prewarm-panel.svelte.test.ts`:
  ```ts
  import { vi } from 'vitest'

  it('persists position-warm settings through postConfig', async () => {
    const posted: unknown[] = []
    const client = {
      getConfig: async () => ({ bbox: null, sources: [], minzoom: 6, maxzoom: 12, positionWarm: { enabled: false, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: [] } }),
      postConfig: async (c: unknown) => { posted.push(c) }
    }
    // The panel builds the settings payload from its controls; pin that builder here.
    const { buildConfigPayload } = await import('./settings-payload.js')
    const payload = buildConfigPayload({ enabled: true, radiusMeters: 5556, moveThresholdMeters: 1852, intervalSecs: 120, baseZoom: 13, sources: ['seamark'] })
    await client.postConfig(payload)
    expect(posted[0]).toMatchObject({ positionWarm: { enabled: true, radiusMeters: 5556, intervalSecs: 120 } })
  })
  ```
- [ ] Run it and watch it fail: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/prewarm-panel.svelte.test.ts`. Expected FAIL (`settings-payload.js` does not exist).
- [ ] Minimal implementation, part 1: create `src/features/prewarm/settings-payload.ts`:
  ```ts
  /** Build the /api/prewarm/config payload from the panel's position-warm controls. SI units (meters,
   * seconds); the panel converts from the display unit through UnitField before calling this. */

  import type { PositionWarmSettings } from 'signalk-binnacle-chart-sources'

  export function buildConfigPayload (settings: PositionWarmSettings): { positionWarm: PositionWarmSettings } {
    return { positionWarm: settings }
  }
  ```
  (Note: `PositionWarmSettings` is defined in the plugin's `prewarm-store.ts`, not the shared package. For the webapp, declare a matching local interface in `settings-payload.ts` rather than importing across repos; keep the field names identical. Adjust the import line to a local `export interface PositionWarmSettings { enabled: boolean, radiusMeters: number, moveThresholdMeters: number, intervalSecs: number, baseZoom: number, sources: string[] }`.)
- [ ] Minimal implementation, part 2: add the position-warm section to `PrewarmPanel.svelte`: a toggle bound to `enabled`, `UnitField` for `radiusMeters` and `moveThresholdMeters` (the unit comes from the server length preference via the units store, converting display to meters on commit, exactly like `AnchorPanel.svelte:96`), number inputs for `intervalSecs` (minimum 60) and `baseZoom`, and the source checkboxes. On change, call `postConfig(buildConfigPayload(settings))`. Load the current settings with `getConfig()` on open. Keep the section visually consistent with the box section (same primitives, tokens, and spacing).
- [ ] Run it and watch it pass: `cd /home/dietpi/src/signalk-binnacle && npx vitest run src/features/prewarm/prewarm-panel.svelte.test.ts`. Expected PASS. Then `npm run check`, `npm run lint`, and `npm run build`. Expected PASS.
- [ ] Commit: `feat(binnacle): add the position-warm settings to the prewarm panel`

---

## Release

### Task 18 [Phase A and B]: docs and release per the SignalK plugin pre-push checklist

**Files:**
- Modify `CHANGELOG.md` and `README.md` in `/home/dietpi/src/signalk-binnacle-companion`, `/home/dietpi/src/signalk-binnacle`, and `/home/dietpi/src/signalk-binnacle-chart-sources`.
- Modify the `version` and any stale architecture docs (`CLAUDE.md`, `docs/`) made stale by this work.

**Interfaces:**
- Consumes: the completed Phase A and Phase B work, all gates green.
- Produces: dated CHANGELOG entries, the README "What's New" overwritten to the new version (single most-recent release, never an accumulating list), version bumps across the package, the plugin, and the webapp, and a refreshed `signalk.recommends` list.

Steps:

- [ ] Run `/simplify` on the full diff across all four codebases and apply the findings (reuse, simplification, efficiency, and altitude). Fix every finding of every severity; skip only the factually refuted.
- [ ] Bring related packages current: `npm outdated`, bump the ranges, refresh the lockfiles, and reinstall, in each repo.
- [ ] Refresh `signalk.recommends` in the plugin `package.json` to cross-link the author's companion and related published SignalK plugins, only where the functional pairing is real.
- [ ] Write the CHANGELOG entries (dated, anchored) and overwrite each README "What's New" to the new version. Describe what changed (the prewarm box, the pinned eviction-exempt cache, the off-plan position-warm), never how it was produced or reviewed. No em dashes, use the Oxford comma, write "and" not the ampersand, "chartplotter" is one word.
- [ ] Bump `version` in all three `package.json` files. Confirm there is no `prepare` or `prepack` script in the plugin `package.json`.
- [ ] Prove the pipeline: in each repo run the full gate (the package: `npm run typecheck && npm test && npm run build`; the plugin: `npm test && npm run typecheck && npm run lint && npm run build`; the container: `cd container && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo build --release`; the webapp: `npm run check && npm run lint && npm run build`). All green.
- [ ] Publish in order: the shared package to npm first, then the tilecache image, then the plugin, then the webapp. Confirm the plugin-ci run exists on the published commit and the registry scores the new version.
- [ ] Commit: `docs: tile cache v2 prewarm release notes and version bumps`

---

## Self-Review

### Spec coverage (every section maps to a task)

- Section 4 (shared package: `tileForLngLat`, `tilesInBbox`, `tileCountInBbox`, zoom clamp, bounds clip, latitude limit, antimeridian rejection): Task 1, Task 2. The container mirror is Task 3.
- Section 5 routes (`POST /warm`, `GET /warm/:jobId`, `POST /warm/:jobId/cancel`, `/cache/stats` per-source average): Task 5, Task 6, Task 7.
- Section 5 cap enforcement and pinning (pre-store cap check, `pinned` column with schema-version bump and drop-and-recreate, pinned-exempt eviction, batched warm puts in a transaction, warm concurrency sub-budget): Task 4, Task 6.
- Section 5 validation (zoom clamp, bbox finite and ordered and within the Mercator limit, tile-count hard cap, lazy enumeration with the shared inverse): Task 3, Task 6, Task 7.
- Section 6 (applicationData persistence resolved to a JSON state file under `getDataDirPath()`, the admin gate ported from crows-nest, `POST /api/prewarm`, `GET /api/prewarm/status/:jobId`, `POST /api/prewarm/cancel/:jobId`, `GET|POST /api/prewarm/config`, `GET /api/cache/stats` proxy): Task 8, Task 9, Task 10.
- Section 6 position-warm loop (subscribe `navigation.position`, outside-box trigger, move threshold, interval at least 60 s, about 16 tiles via zoom plus or minus one, all-errors backoff, `doStop` unsubscribe, no auto re-warm on start): Task 15, Task 16.
- Section 7 (feature-detect via `detectCompanion`, write-token gate, panel-scoped `TerraDrawRectangleMode`, source checkboxes from the registry, zoom controls, live estimate gate via `tileCountInBbox` times the average from `/api/cache/stats` against the free cap, progress poll with a 404-means-gone re-warm, `UnitField` for unit-bearing fields): Task 12, Task 13, Task 14. Phase B position-warm settings: Task 17.
- Section 8 (trust rules, SSRF, tokenless container, SI units): preserved across Task 6 (warm reuses the guarded fetch and the allowlist, no client URL), Task 10 (the admin gate and the plugin-only container reach), and Task 14 and Task 16 (the Signal K read stays in the plugin).
- Section 10 build and release order: the task sequence follows it (package, container, plugin, webapp, docs); Task 11 pins the image tag and bumps the dependency, Task 18 is the release.
- Section 11 decisions in force: all reflected (two phases, compact `/warm` contract with same-formula parity, estimate-and-refuse plus server-side cap, pinned box, panel as single input and plugin as single source of truth, admin gate fail-closed).

### Placeholder scan

Scanned the plan for `TODO`, `FIXME`, `similar to Task`, `...` standing in for code, and unfilled signatures. None remain: every task carries real test code and real implementation code, exact file paths with line references where known, and explicit run commands with the expected FAIL then PASS. The only ellipsis usages inside code are SQL window expressions and Rust literals that are intentional, not omissions.

### Type-consistency check

- Shared package: `tileForLngLat(lng, lat, z): { x, y }`, `tileCountInBbox(source, bbox, [zmin, zmax]): number`, `tilesInBbox(...): ZXY[]`, `MAX_MERCATOR_LAT: number`. The Rust mirror returns `(u32, u32)` and `u64`, same formula and constant.
- Container: `cache.put` gains `pinned: bool`; the four `fetcher.rs` call sites are updated. `put_many_pinned(rows: &[WarmRow], cap_bytes: i64, now: i64) -> PutManyOutcome`. `WarmState` serializes lowercase, matching the webapp `WarmStatus['state']` union (`running | done | cancelled | capped | error`). `/cache/stats` JSON `{ rows, bytes, cap, perSourceAvgBytes }` matches the webapp `CacheStats`.
- Plugin: `PrewarmConfig` and `PositionWarmSettings` are one definition in `prewarm-store.ts`, consumed by the routes, the position-warmer, and the persistence. The route shapes match the webapp client paths under `/plugins/signalk-binnacle-companion/api`.
- Webapp: `CacheStats` and `WarmStatus` in `prewarm-client.ts` are the only definitions; `estimate.ts` and the panel import them. `canPrewarm` and `isTerminal` live once in `estimate.ts` and are shared by the panel and the test.

### Resolved ambiguities (flagged for the reviewer)

1. "applicationData store" (spec section 6): the typed `@signalk/server-api` exposes only `readPluginOptions`/`savePluginOptions` (both surface in the schema config screen, the second input surface the spec forbids) and `getDataDirPath()`. Resolved to a JSON state file under `getDataDirPath()`, mirroring how crows-nest persists its route-draft budget (`plugin.ts:286`). This keeps the values out of `schema()` and out of `savePluginOptions`, satisfying the spec's single-input-surface rule.
2. "Fetch each tile through the existing `get_tile` path" (spec section 5) versus "a warm never evicts" and "stored pinned": the live `get_tile` path stores through `store_200`, which always calls `evict_to` and stores unpinned. Reusing it verbatim would violate both the never-evict and the pinning requirements. Resolved by reusing the fetch primitives (`expand_upstream`, `fetch_upstream`, `read_capped`, `acceptable_content_type`, `strong_etag`, and the egress guards) but giving the warm its own store path (`put_many_pinned` with the pre-store cap check, pinned, batched, no eviction). The spec's intent (no parallel fetcher, all SSRF and body and content-type guards apply unchanged) is honored; only the store differs, which the spec itself requires two paragraphs later.
3. Byte-valued estimate through `UnitField` (spec section 7): bytes are not a Signal K unit category, so `UnitField` displays a humanized byte value with a fixed unit label rather than resolving a server preference; the genuinely unit-bearing position-warm fields (radius, move threshold) resolve the server length preference through the units store, as the rule requires.
4. The basemap (`style` source) is excluded from prewarm: the warm `expand_upstream` path rejects style sources, so the panel filters them out (`prewarmableSources()`). Basemap prewarming would need the style sub-resource expansion path and is out of scope for v2 (v3 PMTiles territory).
