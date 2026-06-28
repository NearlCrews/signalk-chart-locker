# Tile cache and proxy v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A boat-wide, durable, offline-capable cache and proxy for the remote raster chart overlays and the vector basemap, served to every device through the Signal K server.

**Architecture:** A new shared source-registry npm package defines every upstream once. A new container `tilecache` crate (separate, internet-egress image) reverse-proxies and disk-caches the allowlisted sources in one SQLite DB. The companion plugin runs the second container, pushes the allowlist to it, and streams browser tile and style requests to it over the resolved private address. The `signalk-binnacle` webapp imports the registry, feature-detects the companion, and points raster and basemap fetches at the plugin routes, falling back to direct fetch when the companion is absent.

**Tech Stack:** TypeScript (shared package, companion plugin), Rust (axum, tokio, rusqlite bundled, reqwest+rustls-tls-webpki-roots), Svelte 5 + MapLibre (webapp), node --test, vitest, cargo test with tower::ServiceExt.

**Spec:** `docs/superpowers/specs/2026-06-27-tilecache-v1-raster-basemap-proxy-design.md`.

## Global Constraints

- v1 is rasters and the basemap only. Do NOT touch the webapp PMTiles path (`pmtiles.ts`, `block-store.ts`, `block-cached-source.ts`); do NOT retire the `cache: 'no-store'` hack (that is v3). No prewarm (v2).
- The container is tokenless and Signal K agnostic. Only the in-process plugin talks to it via `resolveContainerAddress` after `ensureRunning` with `signalkAccessiblePorts`. Browsers reach tiles only through the plugin route. `signalkAccessiblePorts` must keep the port off the boat LAN.
- The tilecache image is SEPARATE from the offline `router` image (egress isolation). reqwest `default-features = false, features = ["rustls-tls-webpki-roots", "gzip", "brotli"]`. No GDAL, GEOS, PROJ, or OpenSSL in the runtime image. Pin `ring` for rustls to avoid a cmake build dep.
- The proxy is allowlist-keyed by source id, never an open-URL proxy. `reqwest::redirect::Policy::none()`. Reject private, loopback, link-local, multicast, and unspecified resolved IPs before connecting. `z`, `x`, `y` parse as bounded `u32`.
- Cache: one SQLite DB with a `source` column, single writer, WAL, `synchronous=NORMAL` (never OFF), LRU under one global byte cap, `last_access` writes throttled, schema version pragma, `SQLITE_FULL` degrades to serve-without-store. Default conservative cap; relocatable to an external SSD.
- Deterministic numerics flag at `container/.cargo/config.toml` applies workspace-wide; the new crate inherits it (irrelevant to bytes but do not fight it).
- Streaming proxy: forward `Range`, relay `206`/`Content-Range`/`Accept-Ranges`/`ETag`/`Content-Type`/`X-Tilecache` verbatim, pipe with `Readable.fromWeb` (never buffer the whole body), pass `If-None-Match` to `304`, `416` an unsatisfiable range, abort the upstream when the client aborts.
- House writing rules: no em dashes, Oxford commas, write "and" not "&", "chartplotter" is one word, no AI-process talk in any commit, changelog, README, or comment. Run the project's full gate green before each "done" and fix every review finding of every severity.
- Build order is A (shared package), B (tilecache crate and image), C (plugin), D (webapp). Each repo must still work installed alone.

## Review corrections (applied before execution)

A two-agent review of this plan found the issues below. Every one is folded into execution; where a task description conflicts with a correction here, this section wins.

CRITICAL and HIGH:
- Workspace and images: adding `tilecache` to `container/Cargo.toml` members means `cargo build` for ANY member parses every member manifest, so `container/Dockerfile` (the router image) must also `COPY tilecache ./tilecache`, and the new `container/tilecache/Dockerfile` must `COPY` every member dir. The router BINARY gains no new dep and no egress (source is copied, not linked); the gate wording changes from "router image unchanged" to "the router binary gains no new dependency and no egress."
- Shared-package dependency mechanic: `file:../signalk-binnacle-chart-sources` is a DEV-only mechanic for building and testing at the desk. It cannot ship: both consumers publish to npm. Task A3 (release-gated, the owner runs it) publishes `signalk-binnacle-chart-sources` to npm and switches both consumers to a version range. Until then CI and fresh clones of the consumers that need the sibling will not resolve it, which is acceptable on a feature branch (same posture as an unreleased plugin). The shared package needs `"prepare": "tsc"` so a `file:` install builds `dist/`, and `engines.node >= 20`.
- `ContainerConfig.volumes` real shape (from the installed signalk-container types, confirm in `~/.signalk/node_modules/signalk-container`): `volumes?: Record<string, string | { source: string, ifMissing?: 'create' | 'skip' | 'abort' }>` keyed by the in-container mount path, plus `signalkDataMount?: string` (the zero-config durable default) and `user?: string | false`. C1 adds all three. The default cache lives under `signalkDataMount`; `TILECACHE_DB` is a sub-path there. A user-managed external-SSD volume uses the `{ source, ifMissing }` form.
- Companion `package.json` must add `signalk-binnacle-chart-sources` to `dependencies` (C1 or C2), not only import it.
- Split B3 into B3a fetch, validate, store, mint strong ETag; B3b revalidation and negative-cache; B3c single-flight and per-host semaphore and 429 or Retry-After; B3d serve-stale-when-offline and max-stale. One failing test and commit each.
- Registry data: GEBCO is WMS (`wmsTiles('https://wms.gebco.net/mapserv', 'GEBCO_LATEST')`), not xyz. Transcribe every `ChartSource` directly from the real webapp modules at A2 execution: `streaming-sources.ts` (GEBCO wms, EMODnet wms plus `quality_index` style facet, BlueTopo WMTS 512 plus uncertainty wms facet, NOAA ENC wms LAYERS `0,1,2,3,4,5,6,7,10` and quality `8,9`), `seamark-sources.ts`, `ocean-sources.ts`, `boundary-sources.ts`, `mpa-sources.ts`, `base-style.ts`. Add a per-source test that pins each entry's expanded URL against the real module value, so registry drift is caught.
- Webapp async threading: `STREAMING_CHART_SOURCES` and the other `*_SOURCES` are module-level consts consumed synchronously (`ChartCanvas.svelte:334 .map(createStreamingChartOverlay)`), and `baseStyleUrl()` is called synchronously at map init (`themed-map.ts:80`). `detectCompanion` is async. D must convert these const exports to companion-aware factories (or pass a resolved companion base into the builders) and await detection BEFORE map construction. Name the real consumers in each D task.
- Basemap rewrite (its own task, D3 plus a container task in B4): the openfreemap Liberty style references its vector tiles via a TileJSON `source.url`, so the container must walk the style JSON `glyphs`, `sprite` (both `.json` and `.png`), and each `sources[].url`, fetch each TileJSON, and rewrite its nested `tiles[]` too. The container learns its public base (`/plugins/signalk-binnacle-companion`) from `POST /config`. Test the served style AND its TileJSON sub-document are fully plugin-relative.
- GIBS carries a `{date}`. Encode the date in the source `id` (`gibs-sst-YYYY-MM-DD`) so "id fully determines every non-z/x/y parameter" holds. Daily re-push is a v2 concern; v1 pushes the static registry once at start (document the limitation).

MEDIUM:
- Cache table: use a NORMAL rowid table with `PRIMARY KEY (source, z, x, y)` as a UNIQUE index (NOT `WITHOUT ROWID`: KB blobs in the key btree are slower and worse for microSD). Keep a running byte total updated on put and delete (no `SUM(bytes)` scan; `/cache/stats` stays O(1)). Schema mismatch on `user_version` drops and recreates the table (tested). `synchronous=NORMAL`. Document the NFS-WAL caveat for a user volume.
- Concurrency: one writer connection plus a small read-connection pool (or accept a single serialized connection and DROP the "concurrent reads" claim). Pick the pool for the spec's read path.
- reqwest TLS: pin reqwest and select the `ring`-backed rustls feature explicitly; confirm `aws-lc-rs` is not in the lock (it needs cmake, absent from `rust:1-bookworm`).
- v1 is registry-only: `buildSourcePayload` pushes ONLY the shared registry, not Signal K chart resources (a chart resource pointing at a LAN tile server would be blocked by the SSRF private-IP guard, and no D task routes chart-resource rendering through the proxy in v1). Chart-resource proxying is deferred. Drop the `chartResources` parameter.
- `TILECACHE_CAP_BYTES` default: 2 GiB (`2_147_483_648`). Plugin `schema()` exposes the tilecache image tag, the cap, and the optional external-SSD volume source.
- Default image ref: add `DEFAULT_TILECACHE_IMAGE` mirroring `DEFAULT_ROUTER_IMAGE` in `router-container.ts`. Building and pushing the image is release-gated (the owner), like the router image.
- CI: add a tilecache or workspace job to `.github/workflows/ci.yml` (the existing rust jobs are scoped to `container/engine`, so they would miss the new crate).
- B2 parity test: assert WMS-query EQUIVALENCE (parsed params and a bbox within tolerance), not cross-language string identity (JS and Rust format `f64` differently).
- WMS sources stay `tileSize: 256` (all current ones are), so the proxied and direct paths request the same image.

LOW and NIT:
- Mercator: drop "matches MapLibre exactly"; it is bit-exact across the TS and Rust copies (same formula, constant, and IEEE-754) and sub-ULP versus MapLibre, which is irrelevant since the cache key is z/x/y, not the bbox. Test against a precomputed value with a tolerance.
- `AppState` also carries the single-flight map, the per-host semaphore, the negative-cache TTL, the max-stale bound, and the per-blob size cap.
- Streaming proxy: on a bodyless upstream status (`304`, `416`, `204`), set headers and `res.end()` without piping (`Readable.fromWeb(null)` throws). Clear the resolved-address holder to null in `doStop` so `/tiles/ready` reports unavailable after stop.
- Name: use `proxyTileTemplate(pluginBase, sourceId)` everywhere (the spec's `proxyTileUrl` is the older name).
- Resource limits mirror `ROUTER_RESOURCES` with smaller numbers (`memory: '512m'`, `memorySwap` equal to memory, a positive `oomScoreAdj`).
- Readiness route is `/tiles/ready` (the spec's `/tiles/health` is renamed; align the webapp probe).
- The `X-Tilecache: stale` badge in the webapp is OUT of v1 scope (YAGNI). The container still emits the header and the plugin relays it; consuming it is a later sub-milestone. Remove the stale badge from boat-only test 3.

Confirmed sound by the review (do not change): `signalkAccessiblePorts` keeps the port off the LAN; `registerWithRouter(router)` mounts under `/plugins/signalk-binnacle-companion/` and is the right plugin API; rusqlite bundled, reqwest, and ring build on aarch64 distroless; the x86_64 `-fma` flag does not affect them or engine parity; WMS 1.3.0 with `CRS=EPSG:3857` and `BBOX` order `minX,minY,maxX,maxY` has no axis error.

## Repos and file structure

- New repo `~/src/signalk-binnacle-chart-sources` (the shared package). Both other repos depend on it (local `file:` path during dev; the owner publishes to npm later).
- `~/src/signalk-binnacle-companion`: new `container/tilecache/` crate, a new `container/tilecache/Dockerfile`, plus `src/` plugin changes (`shared/types.ts`, a new `runtime/tilecache-container.ts`, `plugin/plugin.ts`, a new `http/tile-routes.ts`).
- `~/src/signalk-binnacle`: webapp changes in `src/shared/map/` and the feature `*-sources.ts` modules, plus a companion-detection module.

---

## Component A: shared source-registry package

### Task A1: Scaffold the package and the web-mercator helper

**Files:**
- Create: `~/src/signalk-binnacle-chart-sources/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/mercator.ts`
- Test: `~/src/signalk-binnacle-chart-sources/test/mercator.test.ts`

**Interfaces:**
- Produces: `SourceKind`, `ChartSource`, `UpstreamTemplate` (exact shapes from spec section 4); `webMercatorTileBounds(z: number, x: number, y: number): [number, number, number, number]` returning EPSG:3857 meters `[minX, minY, maxX, maxY]`.

- [ ] **Step 1: Scaffold.** `package.json` (`name: "signalk-binnacle-chart-sources"`, `type: "module"`, `main`/`types` to `dist/index.js`, scripts `build: tsc`, `test: node --import tsx --test test/*.test.ts`, `typecheck: tsc --noEmit`, dev deps `typescript`, `tsx`), a strict `tsconfig.json` emitting `dist/`. `git init`.

- [ ] **Step 2: Write the failing mercator test.**

```ts
// test/mercator.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { webMercatorTileBounds } from '../src/mercator.js'

const ORIGIN = 20037508.342789244

test('z0 single tile covers the whole web-mercator extent', () => {
  assert.deepEqual(webMercatorTileBounds(0, 0, 0), [-ORIGIN, -ORIGIN, ORIGIN, ORIGIN])
})
test('z1 top-left tile is the upper-left quadrant', () => {
  const [minX, minY, maxX, maxY] = webMercatorTileBounds(1, 0, 0)
  assert.equal(minX, -ORIGIN); assert.equal(maxX, 0)
  assert.equal(maxY, ORIGIN); assert.equal(minY, 0)
})
test('y increases downward (north at the top)', () => {
  const top = webMercatorTileBounds(1, 0, 0)
  const bottom = webMercatorTileBounds(1, 0, 1)
  assert.ok(top[3] > bottom[3]) // top maxY above bottom maxY
})
```

- [ ] **Step 3: Run to fail.** `cd ~/src/signalk-binnacle-chart-sources && npm i && npm test` -> FAIL (module not found).

- [ ] **Step 4: Implement `mercator.ts` and `types.ts`.**

```ts
// src/mercator.ts
const ORIGIN = 20037508.342789244 // half the web-mercator extent in meters
/** EPSG:3857 bounds [minX, minY, maxX, maxY] of XYZ tile z/x/y, matching MapLibre {bbox-epsg-3857}. */
export function webMercatorTileBounds (z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * ORIGIN) / 2 ** z
  const minX = -ORIGIN + x * size
  const maxX = minX + size
  const maxY = ORIGIN - y * size
  const minY = maxY - size
  return [minX, minY, maxX, maxY]
}
```

`types.ts` holds `SourceKind`, `ChartSource`, `UpstreamTemplate` verbatim from spec section 4. `index.ts` re-exports everything.

- [ ] **Step 5: Run to pass.** `npm test` -> PASS. `npm run typecheck` clean.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat: scaffold the chart-sources package and the web-mercator tile-bounds helper"`.

### Task A2: Registry data and the upstream and proxy URL helpers

**Files:**
- Create: `~/src/signalk-binnacle-chart-sources/src/registry.ts`, `src/expand.ts`
- Test: `test/expand.test.ts`, `test/registry.test.ts`

**Interfaces:**
- Consumes: `webMercatorTileBounds`, the types.
- Produces: `CHART_SOURCES: ChartSource[]` (GEBCO xyz, EMODnet wms and quality facet, BlueTopo wmts 512 and uncertainty wms, NOAA ENC wms and quality, OpenSeaMap xyz, GIBS wmts, Marine Regions wms, EMODnet MPA wms, NOAA ArcGIS, and the openfreemap basemap `style`); `expandUpstreamUrl(source: ChartSource, z: number, x: number, y: number): string`; `proxyTileTemplate(pluginBase: string, sourceId: string): string` returning `${pluginBase}/tile/${sourceId}/{z}/{x}/{y}`.

- [ ] **Step 1: Write the failing expand test.**

```ts
// test/expand.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { expandUpstreamUrl } from '../src/expand.js'
import type { ChartSource } from '../src/types.js'

const xyz: ChartSource = { id: 'gebco', title: 'GEBCO', kind: 'xyz', tileSize: 256, minzoom: 0, maxzoom: 9, attribution: 'GEBCO', upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}.png' } }
const wms: ChartSource = { id: 'enc', title: 'ENC', kind: 'wms', tileSize: 256, minzoom: 0, maxzoom: 18, attribution: 'NOAA', upstream: { mode: 'wms', base: 'https://w/wms', layers: '0,1', styles: '', version: '1.3.0', format: 'image/png', transparent: true } }

test('xyz substitutes z/x/y', () => {
  assert.equal(expandUpstreamUrl(xyz, 3, 2, 1), 'https://h/3/2/1.png')
})
test('wms injects the 3857 bbox, CRS, size, layers, styles', () => {
  const url = new URL(expandUpstreamUrl(wms, 0, 0, 0))
  assert.equal(url.searchParams.get('REQUEST'), 'GetMap')
  assert.equal(url.searchParams.get('CRS'), 'EPSG:3857')
  assert.equal(url.searchParams.get('WIDTH'), '256')
  assert.equal(url.searchParams.get('LAYERS'), '0,1')
  assert.match(url.searchParams.get('BBOX') ?? '', /^-20037508/)
})
```

- [ ] **Step 2: Run to fail.** `npm test` -> FAIL.

- [ ] **Step 3: Implement `expand.ts`.** Switch on `source.upstream.mode`: `xyz` and `wmts` do bounded string substitution of `{z}/{x}/{y}` (and `{y}`/`TILEROW`/`TILECOL` for wmts); `wms` builds the GetMap query with `webMercatorTileBounds` joined by commas for `BBOX` and `WIDTH`/`HEIGHT` from `tileSize`; `arcgis` builds the export query with the same bbox; `style` returns `styleUrl` (sub-resources are expanded by the container, not here). Reject z/x/y outside `0..2^z` by throwing (the container validates first, this is defense in depth).

- [ ] **Step 4: Write `registry.ts`** mirroring the webapp source modules (see spec section 3 and the webapp `streaming-sources.ts`, `seamark-sources.ts`, `ocean-sources.ts`, `boundary-sources.ts`, `mpa-sources.ts`, `base-style.ts` for the exact bases, layers, styles, and zoom ranges). Add `test/registry.test.ts` asserting every `id` is unique, every source's `expandUpstreamUrl` at its minzoom is a valid absolute URL, and the basemap is the single `style` kind.

- [ ] **Step 5: Run to pass.** `npm test` and `npm run typecheck` clean.

- [ ] **Step 6: Commit.** `git commit -m "feat: add the chart-source registry and the upstream and proxy URL helpers"`.

---

## Component B: container tilecache crate and image

### Task B1: Crate scaffold and the SQLite cache store

**Files:**
- Create: `container/tilecache/Cargo.toml`, `container/tilecache/src/lib.rs`, `container/tilecache/src/cache.rs`
- Modify: `container/Cargo.toml` (add `tilecache` to `members`)
- Test: cache unit tests inline in `cache.rs` (`#[cfg(test)]`).

**Interfaces:**
- Produces: `struct TileCache` opened at a path, with `get(&self, source, z, x, y) -> Option<CachedTile>`, `put(&self, ...) -> Result<()>` (single writer), `evict_to(&self, cap_bytes)`, `touch(&self, ...)` (throttled), and a `CachedTile { content_type, strong_etag, upstream_validator, status, bytes, blob }`. Schema and pragmas exactly per spec section 5.

- [ ] **Step 1: Add the crate to the workspace** and a minimal `lib.rs`. `Cargo.toml` deps: `rusqlite { version = "0.31", features = ["bundled"] }`, `axum = "0.7"`, `tokio`, `serde`, `serde_json`, `reqwest { default-features = false, features = ["rustls-tls-webpki-roots", "gzip", "brotli"] }`, `sha2` (strong etag hash).

- [ ] **Step 2: Write failing cache tests** (in `cache.rs` `#[cfg(test)]`): open an in-memory or tempfile DB; `put` then `get` round-trips bytes, content_type, and validators; a second `put` on the same key replaces; `evict_to(small_cap)` deletes the least-recently-accessed row first; a negative-cache row (`status = 404`, `blob = None`) round-trips; `touch` updates `last_access`. Use `tempfile` dev-dep.

- [ ] **Step 3: Implement `cache.rs`.** Open with `OpenFlags::SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_CREATE`, run pragmas (`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `wal_autocheckpoint`), `CREATE TABLE IF NOT EXISTS tiles (...) WITHOUT ROWID` per spec, set a `user_version` schema marker. One `Mutex<Connection>` writer (or a single owned connection behind a write method) so concurrent writers serialize; reads may share. `evict_to` runs `DELETE FROM tiles WHERE (source,z,x,y) IN (SELECT ... ORDER BY last_access LIMIT ...)` until under `cap_bytes`, computed from `SUM(bytes)`. `touch` batches or coarsens `last_access`. On `rusqlite::Error` mapped to `SQLITE_FULL`, the `put` returns an `Ok`-degraded signal so the caller serves without storing.

- [ ] **Step 4: Run to pass.** `cd container && cargo test -p binnacle-tilecache` -> PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(tilecache): add the crate and the microSD-aware SQLite tile cache"`.

### Task B2: Upstream URL builder and the SSRF guards

**Files:**
- Create: `container/tilecache/src/upstream.rs`, `container/tilecache/src/ssrf.rs`
- Test: inline `#[cfg(test)]`.

**Interfaces:**
- Consumes: a Rust mirror of `ChartSource`/`UpstreamTemplate` (deserialized from the plugin `POST /config`; serde camelCase to match the package JSON).
- Produces: `expand_upstream(source, z, x, y) -> Result<String, BadRequest>` (mirrors the package helper, bounded params), and `fn is_forbidden_ip(ip: IpAddr) -> bool` plus `async fn resolve_and_check(host) -> Result<(), Ssrf>` that rejects private, loopback, link-local, multicast, and unspecified resolved addresses.

- [ ] **Step 1: Write failing tests.** `expand_upstream` matches the package output for xyz and wms at known z/x/y (the same EPSG:3857 origin constant); out-of-range `x`/`y`/`z` returns the bad-request error. `is_forbidden_ip` is true for `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `::1`, `224.0.0.1`, and false for a public IP.

- [ ] **Step 2: Run to fail.** `cargo test -p binnacle-tilecache` -> FAIL.

- [ ] **Step 3: Implement.** `upstream.rs` ports the web-mercator math (same `ORIGIN`) and per-kind expansion. `ssrf.rs` implements `is_forbidden_ip` over `IpAddr` (use `is_private`, `is_loopback`, `is_link_local`, `is_multicast`, `is_unspecified`, plus IPv6 ULA `fc00::/7` and v4-mapped checks) and `resolve_and_check` via `tokio::net::lookup_host`.

- [ ] **Step 4: Run to pass.** `cargo test -p binnacle-tilecache` -> PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(tilecache): add the upstream URL builder and the SSRF guards"`.

### Task B3: The fetcher (HTTP, validation, single-flight, negative cache, revalidation)

**Files:**
- Create: `container/tilecache/src/fetcher.rs`
- Test: inline `#[cfg(test)]` against a stub HTTP server (`axum` test server or `wiremock`).

**Interfaces:**
- Consumes: `TileCache`, `expand_upstream`, `resolve_and_check`.
- Produces: `async fn get_tile(state, source_id, z, x, y) -> TileResponse` where `TileResponse { status, content_type, etag, stale: bool, body: Bytes }` or a typed decline (`NotAllowed`, `BadRequest`, `Upstream(code)`). Builds the `reqwest::Client` once with `redirect::Policy::none()`, a `User-Agent`, and a per-host concurrency `Semaphore`. Single-flight via a `Mutex<HashMap<key, Shared future>>` or `tokio::sync` once-cell per key.

- [ ] **Step 1: Write failing tests** with a stub upstream: a 200 image is fetched, stored, and returned with a minted strong ETag; a second request is a cache hit (stub hit-count stays 1); a `200` with `Content-Type: text/xml` (a WMS ServiceException) is rejected and not stored; a `404` negative-caches; with the network stub down and a cached row present, `get_tile` serves stale with `stale = true`; an `If-None-Match` match returns `304`; two concurrent identical misses coalesce to one upstream hit (single-flight).

- [ ] **Step 2: Run to fail.** `cargo test -p binnacle-tilecache` -> FAIL.

- [ ] **Step 3: Implement `fetcher.rs`** per the test and spec section 5 (validate status and content-type, mint the strong ETag with `sha2`, store via `TileCache::put`, revalidate with the stored `upstream_validator`, negative-cache 404/204 with a short TTL, honor 429/`Retry-After`, cap per-blob size, serve-stale-when-offline with the marker).

- [ ] **Step 4: Run to pass.** `cargo test -p binnacle-tilecache` -> PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(tilecache): add the fetcher with validation, single-flight, negative cache, and offline serve-stale"`.

### Task B4: The axum app and routes

**Files:**
- Create: `container/tilecache/src/routes.rs`; extend `lib.rs` with `app(state) -> Router`.
- Test: inline `#[cfg(test)]` with `tower::ServiceExt::oneshot`.

**Interfaces:**
- Consumes: the fetcher, the config store.
- Produces: `app(state: AppState) -> Router` with `GET /tile/:source/:z/:x/:y`, `GET /style/:source` and `GET /style/:source/*rest`, `POST /config`, `GET /health`, `GET /cache/stats`. `AppState { cache, client, sources: Arc<RwLock<HashMap<String, ChartSource>>>, cap_bytes }`.

- [ ] **Step 1: Write failing route tests** (`oneshot`): `GET /health` -> `{"status":"ok"}` with an empty config; `POST /config` then `GET /tile/gebco/0/0/0` against a stub upstream returns bytes + a strong `ETag`; an unknown source 404s; a removed source (re-POST without it) 404s; out-of-range z/x/y 400s; `GET /cache/stats` returns counters.

- [ ] **Step 2: Run to fail.** `cargo test -p binnacle-tilecache` -> FAIL.

- [ ] **Step 3: Implement `routes.rs`** wiring handlers to the fetcher, parsing bounded `u32` path params, applying `If-None-Match`, and setting `ETag`, `Content-Type`, `Cache-Control`, and `X-Tilecache` headers. `/style` proxies and rewrites the basemap style JSON sub-resource URLs to plugin-relative paths.

- [ ] **Step 4: Run to pass.** `cargo test -p binnacle-tilecache` -> PASS. `cargo clippy -p binnacle-tilecache --all-targets -- -D warnings` clean.

- [ ] **Step 5: Commit.** `git commit -m "feat(tilecache): add the axum routes for tiles, style, config, health, and stats"`.

### Task B5: main.rs, the Dockerfile, and the image build

**Files:**
- Create: `container/tilecache/src/main.rs`, `container/tilecache/Dockerfile`
- Test: build + a healthcheck smoke.

**Interfaces:**
- Consumes: `app`, `TileCache`.
- Produces: a `tilecache` binary with a `healthcheck` subcommand (mirrors `container/router/src/main.rs`), reading `TILECACHE_PORT` (default 8080), `TILECACHE_DB`, and `TILECACHE_CAP_BYTES`, with graceful SIGTERM and SIGINT shutdown.

- [ ] **Step 1: Implement `main.rs`** copying the `router` main shape: arg check for `healthcheck` (TCP connect to `127.0.0.1:port`, exit 0/1), open the cache at `TILECACHE_DB`, bind the listener, `axum::serve` with `with_graceful_shutdown`.

- [ ] **Step 2: Write `container/tilecache/Dockerfile`** mirroring `container/Dockerfile`: builder `FROM rust:1-bookworm` building `--release --bin tilecache` from the workspace, runtime `FROM gcr.io/distroless/cc-debian12`, copy `/tilecache`, `EXPOSE 8080`, `HEALTHCHECK [CMD ["/tilecache","healthcheck"]]`, `ENTRYPOINT ["/tilecache"]`. Note: build with `podman build --format docker` or the HEALTHCHECK drops.

- [ ] **Step 3: Build.** `cd container && cargo build --release --bin tilecache` (slow first build on the Pi, allow a long timeout). Then `podman build --format docker -t binnacle-tilecache container -f container/tilecache/Dockerfile`. Verify the image runs and `/health` answers on a fresh port with a tempfile `TILECACHE_DB`.

- [ ] **Step 4: Run the full Rust gate.** `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo build --release --bin router --bin tilecache`. All green.

- [ ] **Step 5: Commit.** `git commit -m "feat(tilecache): add the binary entrypoint and the distroless image"`.

---

## Component C: companion plugin

### Task C1: Extend ContainerConfig and build the tilecache container config

**Files:**
- Modify: `src/shared/types.ts` (add `volumes`, `user` to `ContainerConfig`)
- Create: `src/runtime/tilecache-container.ts`
- Test: `test/tilecache-container.test.ts`

**Interfaces:**
- Produces: `ContainerConfig.volumes?: ContainerVolume[]` and `user?: string | false`; `TILECACHE_CONTAINER_NAME`, `TILECACHE_INTERNAL_PORT = 8080`, `buildTilecacheConfig(opts) -> ContainerConfig` (image, tag, `signalkAccessiblePorts: [TILECACHE_INTERNAL_PORT]`, healthcheck `['/tilecache','healthcheck']`, a resource cap, the cache volume, and `env` with `TILECACHE_DB` and `TILECACHE_CAP_BYTES`), and `probeTilecacheHealth(address, fetchFn)`.

- [ ] **Step 1: Write failing tests** mirroring `test/router-container.test.ts`: `buildTilecacheConfig` sets the port, the healthcheck command, an env `TILECACHE_DB` under the mounted volume, and a `volumes` entry; `probeTilecacheHealth` returns true on `{status:'ok'}`.

- [ ] **Step 2: Run to fail.** `npm test -- test/tilecache-container.test.ts` -> FAIL.

- [ ] **Step 3: Implement.** Add the `ContainerVolume` type (`{ source?: string, target: string, ifMissing?: 'skip' | 'abort' }`) and the two fields to `ContainerConfig`. Write `tilecache-container.ts` copying `router-container.ts`. Default the cache volume to the Signal K data mount with a sub-path, env `TILECACHE_DB` to that path.

- [ ] **Step 4: Run to pass + typecheck.** `npm test -- test/tilecache-container.test.ts && npm run typecheck` clean.

- [ ] **Step 5: Commit.** `git commit -m "feat(plugin): add volumes and user to ContainerConfig and the tilecache container config"`.

### Task C2: Run the second container and push the allowlist

**Files:**
- Modify: `src/plugin/plugin.ts` (start the tilecache container after the router, resolve its address, push the config)
- Create: `src/runtime/tilecache-config-push.ts` (build the `POST /config` payload from the shared registry plus Signal K chart resources, post it)
- Test: `test/tilecache-config-push.test.ts`, extend `test/plugin-integration.test.ts`

**Interfaces:**
- Consumes: `signalk-binnacle-chart-sources` (`CHART_SOURCES`), `buildTilecacheConfig`, the container manager.
- Produces: `buildSourcePayload(chartResources) -> { sources: ChartSource[] }` (union of the registry and `tilelayer`/`tileJSON` chart resources), `pushTilecacheConfig(address, payload, postFetch)`.

- [ ] **Step 1: Write failing tests.** `buildSourcePayload` includes every registry source and maps a Signal K `tilelayer` chart resource to an `xyz` `ChartSource`; `pushTilecacheConfig` POSTs to `/config`. Extend the integration test: when the manager resolves an address, the plugin pushes config and the tilecache lifecycle does not break the router lifecycle.

- [ ] **Step 2: Run to fail.** `npm test` -> FAIL.

- [ ] **Step 3: Implement.** In `plugin.ts doStart`, after the router bridge, `ensureRunning(TILECACHE_CONTAINER_NAME, buildTilecacheConfig({tag}), {pluginId})`, `resolveContainerAddress`, probe, then `pushTilecacheConfig`. Store the resolved address for the route module (a module-level holder or a passed reference). On a chart-resources change, re-push (a Signal K resources subscription, or re-push on the next request if simplest for v1).

- [ ] **Step 4: Run to pass + typecheck + lint.** `npm test && npm run typecheck && npm run lint` green.

- [ ] **Step 5: Commit.** `git commit -m "feat(plugin): run the tilecache container and push the source allowlist"`.

### Task C3: The streaming proxy routes

**Files:**
- Create: `src/http/tile-routes.ts` (an express router factory), `test/tile-routes.test.ts`
- Modify: `src/plugin/plugin.ts` (add `registerWithRouter` to the plugin object)

**Interfaces:**
- Consumes: the resolved tilecache address.
- Produces: `createTileRouter(getAddress: () => string | null, fetchImpl) -> Router` mounting `GET /tile/:source/:z/:x/:y`, `GET /style/:source`, `GET /style/:source/*`, and `GET /tiles/ready` (the webapp feature-detect). The plugin object gains `registerWithRouter(router)`.

- [ ] **Step 1: Write failing tests** with a stub container HTTP server and `supertest` (or a fake req/res): a tile request streams the body and relays `Content-Type`, `ETag`, and `X-Tilecache`; a `Range` header is forwarded and a `206`/`Content-Range` relayed; `If-None-Match` yields `304`; an aborted client request aborts the upstream fetch; `/tiles/ready` returns ok only when the address is non-null.

- [ ] **Step 2: Run to fail.** `npm test -- test/tile-routes.test.ts` -> FAIL.

- [ ] **Step 3: Implement `tile-routes.ts`** using `fetch` to the container with the inbound `Range` and `If-None-Match` forwarded and an `AbortController` tied to the client `req` `close`/`aborted`, piping `Readable.fromWeb(res.body)` to the express `res`, relaying status and the headers listed in the Global Constraints, never buffering. Add `registerWithRouter(router) { router.use(createTileRouter(...)) }` to the plugin.

- [ ] **Step 4: Run the full plugin gate.** `npm test && npm run typecheck && npm run lint && npm run build` green.

- [ ] **Step 5: Commit.** `git commit -m "feat(plugin): stream tile and style requests to the tilecache container"`.

---

## Component D: signalk-binnacle webapp

### Task D1: Depend on the registry and a companion-detection module

**Files:**
- Modify: `~/src/signalk-binnacle/package.json` (add the `file:` dep), the raster source modules to read from the registry.
- Create: `~/src/signalk-binnacle/src/shared/map/companion.ts` (feature-detect)
- Test: `src/shared/map/companion.test.ts`, and update the existing source-module tests.

**Interfaces:**
- Produces: `detectCompanion(serverBase, fetchImpl): Promise<{ present: boolean, base: string }>` probing `/plugins/signalk-binnacle-companion/tiles/ready`; the source modules build their `RasterOverlaySource.tiles[]` from `CHART_SOURCES`.

- [ ] **Step 1: Write the failing detection test.** `detectCompanion` returns `present: true` on a 200 from `/tiles/ready`, `false` on a 404 or a network error.

- [ ] **Step 2: Run to fail.** `cd ~/src/signalk-binnacle && npm i ../signalk-binnacle-chart-sources && npm test -- companion` -> FAIL.

- [ ] **Step 3: Implement `companion.ts`** and repoint `streaming-sources.ts`, `seamark-sources.ts`, `ocean-sources.ts`, `boundary-sources.ts`, `mpa-sources.ts` to derive their source definitions from `CHART_SOURCES` (keep the MapLibre-facing `RasterOverlaySource` shape; the registry is the single definition). Do not change the rendered URLs yet (still direct upstream) so the existing tests stay green except where they now read from the registry.

- [ ] **Step 4: Run to pass.** `npm test && npm run check` green.

- [ ] **Step 5: Commit.** `git commit -m "feat: depend on the shared chart-source registry and add companion detection"`.

### Task D2: Route rasters through the proxy when the companion is present

**Files:**
- Modify: the source modules and `src/shared/map/raster-overlay.ts` (or the seam) to build proxied `tiles[]` when the companion is present.
- Test: update the source-module tests for both modes.

**Interfaces:**
- Consumes: `detectCompanion`, `proxyTileTemplate`.
- Produces: source `tiles[]` are `${companionBase}/tile/${id}/{z}/{x}/{y}` when present, else the direct upstream.

- [ ] **Step 1: Write failing tests.** With the companion present, a source's `tiles[0]` is the plugin proxy template; absent, it is the direct upstream URL.

- [ ] **Step 2: Run to fail.** `npm test` -> FAIL.

- [ ] **Step 3: Implement** the conditional URL build at the source-construction seam, threading the detection result. WMS, WMTS, and ArcGIS sources all become the same `/tile/{id}/{z}/{x}/{y}` proxy template (the container expands the real upstream), so the webapp no longer builds WMS queries when proxied.

- [ ] **Step 4: Run to pass.** `npm test && npm run check && npm run lint` green.

- [ ] **Step 5: Commit.** `git commit -m "feat: route raster overlays through the companion proxy when present"`.

### Task D3: Route the basemap through the proxy, with the fallback

**Files:**
- Modify: `src/shared/map/base-style.ts` (proxy the style, glyphs, sprite, and vector tiles when present; keep openfreemap and `fallbackBaseStyle()` when absent)
- Test: `src/shared/map/base-style.test.ts` (or the existing one)

**Interfaces:**
- Consumes: `detectCompanion`.
- Produces: `baseStyleUrl()` returns the proxied `/style/{basemap}` when the companion is present, else `VECTOR_STYLE_URL`.

- [ ] **Step 1: Write failing tests.** Present -> `baseStyleUrl()` is the plugin `/style/...` URL and the glyphs URL is plugin-relative; absent -> the openfreemap URLs unchanged.

- [ ] **Step 2: Run to fail.** `npm test -- base-style` -> FAIL.

- [ ] **Step 3: Implement** the conditional in `base-style.ts`. When present, the style URL and `GLYPHS_URL` resolve to the plugin; the container rewrites the style JSON's internal tile, glyph, and sprite URLs. When absent, no change.

- [ ] **Step 4: Run the full webapp gate.** `npm test && npm run check && npm run lint && npm run build` green.

- [ ] **Step 5: Commit.** `git commit -m "feat: serve the vector basemap through the companion proxy when present"`.

---

## Task E: Docs and status

**Files:**
- `signalk-binnacle-chart-sources/README.md`; `signalk-binnacle-companion` CHANGELOG and the M3 handoff and CLAUDE.md status; `signalk-binnacle` CHANGELOG and README What's New.

- [ ] **Step 1:** Document the shared package (what it is, the source list, that both repos import it).
- [ ] **Step 2:** Companion CHANGELOG entry and a status note that the tilecache container and the tile and style routes ship behind the cache volume, plus the boat-only tests.
- [ ] **Step 3:** signalk-binnacle CHANGELOG and a single What's New: the dashboard caches the remote rasters and the basemap through the Binnacle Companion when installed, offline at sea, with a direct-fetch fallback when absent.
- [ ] **Step 4:** Commit each repo. No AI-process talk, no em dashes, Oxford commas.

---

## Final verification gate

- [ ] Shared package: `npm test`, `npm run typecheck` green.
- [ ] Companion: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` green; `cd container && cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo build --release --bin router --bin tilecache` green; the tilecache image builds with `podman build --format docker`.
- [ ] Webapp: `npm test`, `npm run check`, `npm run lint`, `npm run build` green.
- [ ] Run `/simplify` over each repo's diff and fix every finding of every severity.
- [ ] Confirm: the offline `router` image is unchanged and still has no egress; the tilecache port is not reachable from the LAN; a solo `signalk-binnacle` install renders via direct fetch.

## Boat-only tests (cannot run at the desk)

1. The tilecache container launches under `signalk-container` with the cache volume mounted and durable across an image update.
2. Two devices render the rasters and basemap through the plugin route from one shared cache.
3. With the internet pulled, the cached rasters and basemap still render offline, with the stale badge.
4. A solo `signalk-binnacle` install with no companion still renders via direct fetch.

## Self-review notes

- Spec section 4 (shared package): Tasks A1, A2. Section 5 (crate): B1 through B5. Section 6 (plugin): C1 through C3. Section 7 (webapp): D1 through D3. Section 8 to 9 (trust, credentials): enforced across B2 (SSRF), B5 (separate image), C1 (port), and the constraints. Section 10 (testing): each task's tests plus the final gate. Section 11 (build order): the component order.
- Type names consistent across tasks: `ChartSource`, `UpstreamTemplate`, `SourceKind`, `webMercatorTileBounds`, `expandUpstreamUrl`, `proxyTileTemplate`, `TileCache`, `CachedTile`, `get_tile`, `app`, `AppState`, `buildTilecacheConfig`, `buildSourcePayload`, `pushTilecacheConfig`, `createTileRouter`, `detectCompanion`.
- Open risks for execution: the WMS bbox parity (B2 must match the package and MapLibre exactly), the rustls `ring`-vs-cmake build dep (B1, confirm at build), and the streaming abort propagation (C3).
