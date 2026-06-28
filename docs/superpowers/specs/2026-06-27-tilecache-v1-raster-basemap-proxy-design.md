# Tile cache and proxy, v1: raster and basemap proxy and cache

Design spec. Date 2026-06-27. This is sub-milestone 1 of the boat-wide tile and chart cache and
proxy roadmap item (`docs/superpowers/roadmap/2026-06-27-cross-plugin-migration-candidates.md`,
Tier 1 #1). Two later sub-milestones are deferred and out of scope here: v2 prewarm and off-plan
position-warm, and v3 PMTiles ETag range-serving with a block cache.

## 1. Goal

Give the boat one shared, durable, offline-capable cache of the remote raster chart overlays and
the vector basemap, served to every device through the Signal K server, so the dashboard works
offline at sea and stops refetching the same tiles per browser. The container fetches and caches
bytes; the browser keeps MapLibre rendering, styling, and layer control, and decides what is safe
to show.

## 2. Scope

In scope (v1):
- A shared source-registry package both `signalk-binnacle` and the companion import.
- A new container `tilecache` crate and image: a tokenless reverse proxy and disk cache for the
  allowlisted raster overlays and the vector basemap.
- Companion plugin: an HTTP surface on the Signal K server that streams to the container, a config
  push that hands the allowlist to the container, and the cache volume wiring.
- `signalk-binnacle`: import the registry, feature-detect the companion, and point raster and
  basemap fetches at the plugin routes when present, with a clean direct-fetch fallback when absent.

Out of scope (deferred):
- v2: prewarm of a manual bbox, and the throttled off-plan position-warm.
- v3: PMTiles range-serving with strong ETags and the block table. The webapp `pmtiles.ts`,
  `block-store.ts`, and `block-cached-source.ts` paths are NOT touched in v1.
- Any keyed or credentialed upstream. All v1 sources are keyless. The container never holds a
  long-lived secret (see section 9).

## 3. The sources to cache (from the webapp, real shapes)

The headline rasters are NOT Signal K chart resources; they are hardcoded in the webapp feature
modules. v1 covers exactly these, via the shared registry:

- `src/features/depth-charts/streaming-sources.ts`: GEBCO (XYZ), EMODnet bathymetry (WMS GetMap,
  plus a quality facet), BlueTopo (WMTS 512 px, plus a WMS uncertainty facet), NOAA ENC (WMS, plus
  a data-quality facet).
- `src/features/seamark-overlay/seamark-sources.ts`: OpenSeaMap seamarks (XYZ `{z}/{x}/{y}.png`).
- `src/features/ocean-conditions/ocean-sources.ts`: NASA GIBS (WMTS, SST and sea ice, carries a
  `{date}`).
- `src/features/boundaries-overlay/boundary-sources.ts`: Marine Regions EEZ (WMS GetMap).
- `src/features/mpa-overlays/mpa-sources.ts`: EMODnet MPA (WMS) and a NOAA ArcGIS MapServer export.
- The vector basemap: `src/shared/map/base-style.ts` openfreemap Liberty (`VECTOR_STYLE_URL`), its
  glyphs (`GLYPHS_URL`), its sprite, and the vector tiles the style references.

Source kinds, from `src/shared/map/raster-overlay.ts`:
- `xyz`: `tiles[]` template with `{z}/{x}/{y}`.
- `wms`: `wmsTiles(base, layers, styles)` builds
  `{base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS={layers}&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true&STYLES={styles}`.
- `wmts`: `{z}/{y}/{x}` or `TILEROW={y}&TILECOL={x}` GetTile, tileSize 256 or 512.
- `arcgis`: `arcgisExportTiles(base)` builds `{base}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true&f=image`.
- `style`: a TileJSON or MapLibre style document (the basemap) whose sub-resources (glyphs, sprite,
  vector tiles) are themselves proxied.

## 4. The shared source-registry package

A new tiny package, name `signalk-binnacle-chart-sources` (published to npm; both repos depend on
it). One definition of every upstream, so the webapp render config and the plugin allowlist never
drift. It contains data and pure helpers only: no MapLibre, no Signal K, no Node or browser APIs.

Exported types (mirroring `RasterOverlaySource` plus the kind discriminant):

```ts
export type SourceKind = 'xyz' | 'wmts' | 'wms' | 'arcgis' | 'style'

export interface ChartSource {
  id: string                 // stable, fully determines every non-z/x/y parameter (LAYERS, STYLES, tileSize, date)
  title: string
  kind: SourceKind
  upstream: UpstreamTemplate  // how the container builds the upstream request (see below)
  tileSize: 256 | 512
  minzoom: number
  maxzoom: number
  bounds?: [number, number, number, number]
  attribution: string
  group?: { id: string, title: string }
}

// What the CONTAINER needs to build the upstream request. The browser-facing path is always
// /tile/{source}/{z}/{x}/{y} (or /style/{source}); the container expands this per kind.
export type UpstreamTemplate =
  | { mode: 'xyz', urlTemplate: string }                                   // {z}/{x}/{y} substitution
  | { mode: 'wmts', urlTemplate: string }                                  // {z}/{y}/{x} or TILEROW/TILECOL
  | { mode: 'wms', base: string, layers: string, styles: string, version: '1.3.0', format: string, transparent: boolean }
  | { mode: 'arcgis', base: string }
  | { mode: 'style', styleUrl: string, allowedHosts: string[] }           // basemap: style doc + its sub-resource hosts
```

Helpers (pure, both sides use): `webMercatorTileBounds(z, x, y): [minX, minY, maxX, maxY]` in
EPSG:3857 meters, computed to match MapLibre's `{bbox-epsg-3857}` exactly (the canonical
`origin = -20037508.342789244`, `size = 2 * origin / 2^z`); a `expandUpstreamUrl(source, z, x, y)`
the container uses; and `proxyTileUrl(base, sourceId)` the webapp uses to build the plugin-facing
template. The webapp builds its `RasterOverlaySource.tiles[]` from the registry (proxied or direct);
the plugin builds the container `POST /config` payload from the registry. Both consume one list.

Standalone: the package is independent; `signalk-binnacle` keeps working with it whether or not the
companion is installed (the webapp uses the direct upstream when the companion is absent).

## 5. The container `tilecache` crate and image

A new crate in the Cargo workspace (`container/tilecache/`), built as a SEPARATE image from the
offline `router`, so internet egress is isolated from the routing engine and the engine keeps its
zero-egress, minimal-attack-surface guarantee. The crate follows the `router` template
(`container/router/src/{main.rs,lib.rs}`): a `#[tokio::main]` with a `healthcheck` subcommand, a
`TILECACHE_PORT` env (default 8080 inside its own container), `axum::serve` with graceful SIGTERM
shutdown, and an `app(state)` Router unit-tested with `tower::ServiceExt`.

Dependencies: `axum`, `tokio`, `serde`, `serde_json`, `rusqlite` (`bundled`), and `reqwest` with
`default-features = false, features = ["rustls-tls-webpki-roots", "gzip", "brotli"]`. The
webpki-roots variant bakes the Mozilla root store into the binary, so TLS to the upstreams works on
distroless with no `/etc/ssl/certs`. No GDAL, GEOS, PROJ, or OpenSSL: the no-heavy-native-libs rule
holds (reqwest+rustls is pure-Rust crypto via `ring` or `aws-lc-rs`; pin `ring` to avoid a cmake
build dep, confirm at build).

### Routes

- `GET /tile/{source}/{z}/{x}/{y}`: serve a raster overlay tile. `z`, `x`, `y` parse as bounded
  `u32` (`z` within the source min/max, `x`/`y` within `0..2^z`), else 400. Cache hit returns bytes
  with a strong `ETag` and `Content-Type`. Miss fetches the allowlisted upstream (expanded per
  kind), validates, stores, serves. Honors `If-None-Match` to `304`.
- `GET /style/{source}` and the basemap sub-resources (`/style/{source}/sprite...`,
  `/style/{source}/glyphs/{fontstack}/{range}.pbf`, and the vector tiles the style references via
  `/tile/{source}/...`): proxy and cache the style document and its parts, rewriting upstream URLs
  in the served style JSON to plugin-relative ones.
- `POST /config { sources: ChartSource[] }`: the plugin pushes the allowlist on start and on
  change. The container holds only `id -> UpstreamTemplate`; it never reads Signal K. A removed
  source 404s thereafter.
- `GET /health`: `{ "status": "ok" }`, ok even with an empty allowlist.
- `GET /cache/stats`: a thin counter snapshot (row count, bytes, hit/miss), never a full scan.

### Upstream fetch and SSRF guards

- The request is keyed by `source` id (an allowlist index), never a client-supplied URL. There is
  no open-URL route.
- `reqwest::redirect::Policy::none()`: never follow a redirect (an allowlisted host that 302s to a
  LAN or metadata IP must not pivot).
- Resolve the upstream host and reject any target IP that is private, loopback, link-local,
  multicast, or unspecified before connecting (defeats DNS rebinding to `169.254.169.254`,
  `127.0.0.1`, RFC1918).
- Single-flight: coalesce concurrent identical (source, z, x, y) misses into one upstream fetch.
- Per-host concurrency cap and a descriptive `User-Agent`. Honor upstream `429` and `Retry-After`
  (serve stale or a clean 503, never hammer).
- Validate the response: status `200`, and `Content-Type` is `image/*` (or the expected MVT for the
  basemap tiles). A WMS `ServiceException` XML body or an HTML error page returned with `200` is
  rejected and not stored. A `404`/`204` is negative-cached with a short TTL (sparse coverage), never
  a permanent entry. Cap per-blob size to reject a pathological body.

### Cache store (one SQLite DB, microSD-aware)

One bundled-SQLite file (not one per source: a single boat-wide byte budget and an atomic LRU need
one DB), opened read-write with WAL and `synchronous=NORMAL` (survives boat power loss without
corruption; never `OFF`).

```sql
CREATE TABLE tiles (
  source TEXT NOT NULL,
  z INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  strong_etag TEXT NOT NULL,        -- content hash served to the browser (retires the no-store need later)
  upstream_validator TEXT,          -- the upstream's own ETag or Last-Modified, for revalidation
  status INTEGER NOT NULL,          -- 200 cached bytes, or a negative-cache marker
  fetched_at INTEGER NOT NULL,
  last_access INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  blob BLOB,                        -- null for a negative-cache row
  PRIMARY KEY (source, z, x, y)
) WITHOUT ROWID;
```

- Single writer: all writes (miss-store, eviction, negative-cache) funnel through one writer
  connection or a write queue, with `busy_timeout` set, so concurrent misses never hit
  `SQLITE_BUSY`. Reads use the WAL read path.
- `last_access` updates are throttled (a coarse clock, batched) so a pan does not turn every read
  into a write (microSD wear).
- Size cap with LRU eviction by `last_access` under one global byte budget. WAL checkpoint is
  PASSIVE and off the request path; tune `wal_autocheckpoint`. On `SQLITE_FULL`, degrade to
  serve-without-store rather than erroring the tile.
- A schema version pragma so a later upgrade migrates or rebuilds rather than reading stale columns.
- The DB path comes from env (`TILECACHE_DB`), set by the plugin to the mounted volume (section 6).
  Default conservative cap; prefer NVMe or SSD when mounted, microSD with a logged wear warning.

### Offline and revalidation

- Online and stale: conditional revalidation with the stored `upstream_validator`
  (`If-None-Match`/`If-Modified-Since`); a `304` refreshes `fetched_at` and serves cached bytes.
- Offline: serve the cached bytes, never fail a cached tile. Bound max-stale and set a
  `X-Tilecache: stale` response header so the webapp can badge stale chart data (the badge decision
  stays in the UI; the container only serves bytes and a marker).
- The strong client `ETag` is minted from the stored bytes (a content hash), separate from the
  upstream validator (many of these services send weak or no ETags).

## 6. The companion plugin changes

- Extend the `ContainerConfig` type (`src/shared/types.ts`) with `volumes` and `user`, passed
  through to the installed `signalk-container` (which already supports them: `signalkDataMount`,
  user-managed `{ source, ifMissing }` volumes, config-drift tracking of `volumes`). v1 mounts a
  durable cache volume: `signalkDataMount` by default (cache under the Signal K data dir), or a
  user-managed volume pointing at an external SSD when configured. Set `TILECACHE_DB` to a path on
  that mount.
- Add a second managed container via the same proven consumer path as the router
  (`src/runtime/router-container.ts` is the template): `buildTilecacheConfig` with
  `signalkAccessiblePorts: [TILECACHE_INTERNAL_PORT]`, a `healthcheck` (`['/tilecache','healthcheck']`),
  a resource cap (smaller than the router, e.g. 512m), and the cache volume. `ensureRunning` then
  `resolveContainerAddress` then a health probe, exactly like the router. `signalkAccessiblePorts`
  makes the port reachable only from the Signal K server host, NOT the boat LAN, so browsers cannot
  hit the tokenless service or `POST /config` directly.
- Add an HTTP surface. The plugin gains `registerWithRouter(router)` (the Signal K server mounts it
  at `/plugins/signalk-binnacle-companion/`). Routes:
  - `GET /tile/:source/:z/:x/:y` and `GET /style/:source/*`: stream to the container at the resolved
    address. Forward the inbound `Range` header, relay the upstream `206` with `Content-Range`,
    `Accept-Ranges`, `Content-Length`, `ETag`, `Content-Type`, and `X-Tilecache` verbatim, pipe the
    body with `Readable.fromWeb` (never `arrayBuffer()` the whole response on the event loop), pass
    `If-None-Match` through to `304`, and `416` an unsatisfiable range. Abort the upstream fetch when
    the client request aborts or closes (MapLibre cancels tiles on every pan and zoom).
  - `GET /tiles/health` or similar: a thin readiness signal the webapp feature-detects.
- On start and whenever Signal K chart resources change, build the source list from the shared
  registry plus any `tilelayer`/`tileJSON` chart resources and `POST /config` to the container. A
  removed source drops from the allowlist.
- Admin-gate any write or config route; `GET /health` is ok with an empty allowlist (a solo
  companion install is healthy). Prewarm and config writes are admin-only (the existing admin-gate
  pattern, mirrored from crows-nest, applies in v2; v1 only needs the read tile and style routes
  plus the internal config push).

## 7. The signalk-binnacle webapp changes

- Depend on `signalk-binnacle-chart-sources`; build the existing `RasterOverlaySource` list and the
  basemap from the registry, so there is one definition.
- Feature-detect the companion at runtime (probe the plugin readiness route once). When present,
  build each source's `tiles[]` (and the basemap style URL, glyphs, sprite, and vector tiles) as
  plugin-relative proxy URLs (the substitution seam is `src/shared/map/chart-adapter.ts:25 absolute`
  and the source builders in `raster-overlay.ts`). When absent, keep today's direct upstream URLs.
- Do NOT touch the PMTiles path (`pmtiles.ts`, `block-store.ts`, `block-cached-source.ts`): those
  stay as-is for v1 and remain the standalone fallback for remote archives. The `cache: 'no-store'`
  hack is NOT retired in v1 (that is v3).
- Basemap: when the companion is present, rewrite `base-style.ts` to fetch the style, glyphs,
  sprite, and vector tiles through the plugin; when absent, the current openfreemap URLs and the
  `fallbackBaseStyle()` remain. This makes the basemap genuinely offline at sea, the largest gap.
- Optional, non-blocking: badge a layer when the container served stale bytes (`X-Tilecache: stale`).

## 8. Architecture and trust rules (unchanged, restated)

- One npm package per repo for the plugin; the container is a build artifact. The shared
  source-registry is its own separate published package, not part of the companion plugin package.
- The container is tokenless and Signal K agnostic. Only the in-process plugin talks to it, via
  `resolveContainerAddress` after `ensureRunning` with `signalkAccessiblePorts`. Browsers reach
  tiles only through the plugin route on the Signal K server.
- The tilecache container has internet egress (the one online container); the routing engine stays
  fully offline in its own image. The allowlist is the egress boundary and the SSRF guard.
- Units are SI internally; not relevant to bytes here.
- The container serves bytes and a stale marker; it never decides what is safe to show. The trust
  boundary (what chart data is trustworthy, how stale is too stale) stays in the webapp.

## 9. Credentials

All v1 sources are keyless. The container holds no long-lived secret. If a keyed source is ever
added, the plugin injects the credential into the per-source `POST /config` push at runtime and the
container holds it only in memory for the session; a long-lived secret is never written to the
container image or the cache DB. This is a forward rule, not v1 work.

## 10. Testing

- Shared registry: pure unit tests for `webMercatorTileBounds` (against known MapLibre
  `{bbox-epsg-3857}` values at several z/x/y), `expandUpstreamUrl` per kind, and the proxy-URL
  builder. Same tests run in both repos' runners since the package is shared.
- `tilecache` crate (Rust, `tower::ServiceExt`): cache hit, miss-then-store, ETag and `304`,
  negative-cache of a 404, content-type rejection of a 200 XML/HTML body, LRU eviction under the byte
  cap, single-flight coalescing, the SSRF rejections (redirect, private IP, out-of-range z/x/y), the
  WMS bbox expansion, serve-stale-when-offline with the stale marker, and `POST /config` add and
  remove. `cargo clippy --workspace --all-targets -- -D warnings`, release build, and the distroless
  image build green.
- Companion plugin (node --test): `buildTilecacheConfig` shape and the new `volumes`/`user` fields,
  the streaming proxy route (Range forwarding, abort propagation, 304, 416) against a stub container,
  the config-push builder from the registry, and `registerWithRouter` mounting. `npm run typecheck`,
  `npm run lint`, `npm run build` green.
- Webapp (vitest): feature-detect on and off builds proxied vs direct URLs, the basemap rewrite, and
  the registry-driven source list. `npm run check`, `npm run lint`, `npm run build` green.

Boat-only (cannot run without a live server, the container, and the internet):
1. The tilecache container launches under `signalk-container` (`ensureRunning` and
   `resolveContainerAddress` succeed) with the cache volume mounted and durable across an image
   update.
2. A device renders the rasters and the basemap through the plugin route, and a second device hits
   the warm cache (one upstream fetch, two devices served).
3. Pulling the internet still serves the cached rasters and basemap offline, with the stale badge.
4. A solo `signalk-binnacle` install with no companion still renders via direct fetch.

## 11. Build order

1. The shared `signalk-binnacle-chart-sources` package (types, registry data, the pure helpers,
   tests). Nothing depends on a running container.
2. The `tilecache` crate and image (cache, upstream builder, SSRF, routes), fully testable with
   `tower::ServiceExt` and a stub upstream.
3. The companion plugin: `ContainerConfig` extension, `buildTilecacheConfig`, the second container
   lifecycle, the streaming `registerWithRouter` routes, and the config push.
4. The `signalk-binnacle` webapp: registry import, feature detection, proxy URL substitution, and the
   basemap rewrite, with the direct-fetch fallback.

## 12. Decisions in force

- Three sub-milestones; this is v1 (rasters and basemap). v2 prewarm and v3 PMTiles are separate
  specs. PMTiles range-serving is last (least standalone gain, most webapp coupling).
- The allowlist is the union of the shared registry and the Signal K chart resources, sourced
  through one shared package, because the headline rasters are webapp-internal, not chart resources.
- Separate image for the tilecache (egress isolation), accepting a second managed container.
- One SQLite DB with a `source` column, single writer, WAL, `synchronous=NORMAL`, LRU under one byte
  cap, microSD-aware, relocatable to an external SSD.
- The proxy is allowlist-keyed by source id, never an open-URL proxy; redirects off; private-IP
  egress rejected.
- The webapp feature-detects the companion and falls back to direct fetch, so a solo install never
  blanks the map. The PMTiles and block-store paths are untouched in v1.
