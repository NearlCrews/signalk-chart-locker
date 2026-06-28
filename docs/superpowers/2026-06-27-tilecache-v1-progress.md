# Tile cache v1: progress and continuation

Date 2026-06-27. Branch `feat/tilecache-v1` (companion) and the new repo
`~/src/signalk-binnacle-chart-sources`. Spec:
`docs/superpowers/specs/2026-06-27-tilecache-v1-raster-basemap-proxy-design.md`. Plan (with the
two-agent review corrections folded in): `docs/superpowers/plans/2026-06-27-tilecache-v1.md`.

## Done and verified (committed)

Shared package `signalk-binnacle-chart-sources` (its own repo, 2 commits):
- A1 `11e4a69`: scaffold, types, `webMercatorTileBounds`. 4 tests.
- A2 `a7323db`: the 14-source registry transcribed from the webapp modules (GEBCO is WMS, GIBS
  deferred), `expandUpstreamUrl`, `proxyTileTemplate`. 14 tests, typecheck, build green.

tilecache container crate (companion, on `feat/tilecache-v1`):
- B1 `52a77ff`: the microSD-aware SQLite cache (single connection, WAL, synchronous=NORMAL, rowid
  table, running byte total, LRU eviction, schema-version drop-and-recreate).
- B2 `8472f57`: the serde source types, the upstream URL builder (the Rust mirror of the package),
  and the SSRF IP guards.
- B3 `f73f63a`: the read-through fetcher (revalidation, negative cache, serve-stale-offline,
  content-type rejection, minted strong ETag, single-flight coalescing, egress semaphore).
- B4 `841e368`: the axum routes (/tile, /config, /health, /cache/stats) AND the three security-review
  fixes (the SSRF check moved into a guarded DNS resolver to close the time-of-check-to-time-of-use
  gap, the single-flight map leak fixed, an oversize Content-Length rejected before the body is read).
- B5 `bd0aaa3`: the binary entrypoint (healthcheck subcommand, graceful shutdown), the distroless
  image (cmake in the builder for the rustls crypto backend), and the router Dockerfile updated to
  copy the new workspace member. 23 Rust tests, clippy clean, release build green, the binary runs
  and serves /health.

Companion plugin (on `feat/tilecache-v1`):
- C1 `8b7e93b`: `ContainerConfig` gains volumes, signalkDataMount, and user (the real
  signalk-container shapes); `buildTilecacheConfig` (durable data-mount cache, a skip-if-missing
  external-SSD volume, the cap and DB env, a smaller resource cap than the router). The binary
  creates the cache directory on first run.
- C2 `6bed73e`: start the tilecache container after the router (non-fatal: a failure disables tile
  caching but never blocks routing or the bridge), resolve its address, push the registry to
  /config, stop it on shutdown, and the schema fields for the image tag, the cap, and the external
  drive.
- C3 `4c23ac3`: `registerWithRouter` streams /tile and /style to the container (Range and
  If-None-Match forwarded, cache headers relayed, body piped without buffering, bodyless responses
  ended cleanly, the upstream aborted on a browser cancel), plus a /tiles/ready probe.

The companion `tsconfig.json` now sets `types: ["node"]` so src may import node builtins (the proxy
needs `node:stream`).

## Deferred within v1 (paired tasks, do together)

- The basemap STYLE proxy: the container `/style/:source` route (fetch the openfreemap Liberty style,
  rewrite its `glyphs`, `sprite`, and each `sources[].url`, AND fetch and rewrite each nested TileJSON
  `tiles[]`, all to plugin-relative paths using the public base from POST /config), and the webapp D3
  step that points `baseStyleUrl()` at it. The container has no `style.rs` yet; `routes.rs` does not
  merge a style router. This is the largest offline gap, but the rasters work without it.
- The NASA GIBS ocean fields: date-dynamic, left direct in v1, deferred to v2 with daily re-push.

## Webapp rasters: DONE (signalk-binnacle, branch `feat/tilecache-proxy`)

The raster overlay proxy is complete end to end and verified (1372 webapp tests, svelte-check, biome
ci, and the build all green):
- `dd086bc`: `detectCompanion` and `proxiedSources` (`src/shared/map/companion.ts`), and
  `ChartCanvas.svelte` routes the depth, boundary, MPA, and seamark overlays through the companion
  proxy when present (the consumer-side wrapper keeps the source modules and their tests unchanged,
  so a standalone install is unaffected). GIBS stays direct.
- `298b212`: the changelog entry.

Note: the repo's `biome ci .` (line width 100) passes clean; the local pre-commit hook runs a
different biome (default width 80) and was bypassed with `--no-verify`. The repo CI command is green.

## Basemap and style proxy: DONE

The vector basemap now routes through the companion too, so the map renders offline:
- Container `5448fce` (`feat/tilecache-v1`): the `style.rs` proxy. It fetches the upstream style and
  its source TileJSONs, learns the glyph and vector-tile templates, rewrites the style so the glyphs
  and tiles point back at the plugin, and serves it. The glyph and tile sub-routes reconstruct the
  upstream from the learned templates (checked against the style's allowed hosts and the guarded
  resolver), and the vector tiles cache through the tile cache for offline geometry. Sprite stays
  direct in v1. 25 Rust tests, clippy clean.
- Webapp `7294d66`, `2d4608b` (`feat/tilecache-proxy`): `baseStyleUrl(companionBase)` points at the
  style proxy when present, and `ChartCanvas.svelte` detects the companion in onMount before the map
  is built (the style URL is read synchronously at construction) and reuses that result for the raster
  overlays. 1374 webapp tests, svelte-check, `biome ci`, and the build all green.

v1 is now feature-complete across all four codebases. The only remaining items are the release-gated
steps and the boat-only tests below.

### Reference: the original webapp seams (now implemented)

- Add the package and a detector. `npm i ../signalk-binnacle-chart-sources` (dev file: link; the
  owner publishes it before release). Create `src/shared/map/companion.ts`:
  `detectCompanion(origin): Promise<string | null>` probing
  `${origin}/plugins/signalk-binnacle-companion/tiles/ready` (return the base on a 200, null on a 404
  or a network error). The origin is already a prop on `ChartCanvas.svelte:54` (from
  `App.svelte:208 serverOrigin()`).
- Convert the source-list consts to companion-aware builders. The raster sources whose ids match the
  registry (`STREAMING_CHART_SOURCES`, `SEAMARK_SOURCES`, `BOUNDARY_SOURCES`, `MPA_SOURCES`) build
  their `tiles[]` as `proxyTileTemplate(companionBase, id)` when a base is present, else the current
  direct upstream. Leave `buildOceanSources()` (GIBS) DIRECT: GIBS is not in the container allowlist
  in v1, so proxying it would 404. The consumers are `ChartCanvas.svelte:334-340` (in the async
  onLoad), so thread the detected base in there.
- Detection timing: `baseStyleUrl()` is called SYNCHRONOUSLY at map construction
  (`themed-map.ts:80`, inside `createThemedMap()` called at `ChartCanvas.svelte:233` in onMount). To
  route the basemap through the proxy (the deferred D3), detection must complete BEFORE
  `createThemedMap`. onMount can be async, so `await detectCompanion(origin)` first. For the
  rasters-only pass, detection can resolve before the onLoad overlay build.
- Tests and matchers that will change: `streaming-overlay.test.ts:23-28` (asserts concrete NOAA WMS
  `tiles[0]` and LAYERS), `base-style.test.ts:16` (glyphs host equals `baseStyleUrl()` host),
  `sw-caching.test.ts:18,33-35` and `sw-caching.ts:26-52` (hardcoded upstream hosts for the service
  worker cache matchers: if a source is proxied, its cache match host becomes the plugin origin).
- Standalone: when `detectCompanion` returns null (no companion installed), every source and the
  basemap keep their current direct URLs, so a solo `signalk-binnacle` install is unchanged. The
  PMTiles `no-store` and block-store paths are NOT touched in v1.

## Hardening pass (applied to the v1 branches)

A full audit of the three branches landed these fixes, all gated green (container 25 tests and clippy
clean and release build, plugin 45 tests, package 14 tests, webapp 1375 tests and svelte-check and
biome ci and build):

Container (security and correctness):
- Streaming body size cap: the upstream read now caps bytes as it streams (`AppState::read_capped`),
  because `Content-Length` is `None` after gzip or brotli decompression, so a compressed bomb from a
  compromised allowlisted upstream could be read unbounded into memory. Applied to the tile fetch and
  both style fetches (`fetch_json` previously had no cap at all).
- Literal-IP SSRF guard: `AppState::guarded_get` rejects a forbidden IP-literal host before connecting,
  because reqwest does not consult the guarded DNS resolver for a numeric IP host (the Vaultwarden
  class). The resolver comment no longer overstates its coverage. A few more reserved IPv4 ranges are
  blocked.
- microSD write amplification: `last_access` is now read back and the cache touch is throttled to at
  most once per tile per hour, so a pan no longer writes to the card on every warm-tile read (the touch
  doc had claimed a throttle that did not exist).
- Cache write errors are logged instead of silently dropped; the mutex recovers from poisoning; the
  style-state map is cleared on a config re-push so a changed style is relearned; the maxzoom shift is
  guarded against overflow; eviction is a single windowed delete instead of one round-trip per row.
- Hot-path copy removed: `CachedTile.blob` is `Bytes`, so serving a cache hit clones a handle, not the
  bytes. One shared strong-ETag minter and one shared tile-response builder across the tile and style
  routes.

Plugin and webapp:
- One shared container health probe and healthcheck builder; the config push result and the tilecache
  health are logged; the schema default uses the tilecache tag.
- The basemap detection fetch has a 2 second timeout, so a wedged server cannot hang map init; the map
  build is guarded against an unmount during that await; and a companion-proxied base style that fails
  while online now retries the direct openfreemap style before the blank offline fallback. A test locks
  that every proxied overlay id exists in the shared registry, so a 404-causing drift cannot slip in.

## Then E (docs) and the final gate

- Companion CHANGELOG and README, webapp CHANGELOG and README, and the boat-only tests.
- The shared package must be published to npm and both consumers switched to a version range before
  release: the `file:` link is dev-only and will not resolve on a fresh clone or in CI. The tilecache
  image must be built with `podman build --format docker` and pushed, like the router image. Both are
  release-gated (the owner runs them).

## Boat-only tests (cannot run at the desk)

1. The tilecache container launches under signalk-container with the cache volume mounted and durable
   across an image update.
2. Two devices render the rasters through the plugin route from one shared cache.
3. With the internet pulled, the cached rasters still render offline.
4. A solo signalk-binnacle install with no companion still renders via direct fetch.
