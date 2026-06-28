# Tile cache v2: prewarm box and off-plan position-warm

Design spec. Date 2026-06-28. Sub-milestone 2 of the boat-wide tile and chart cache and proxy
roadmap item (`docs/superpowers/roadmap/2026-06-27-cross-plugin-migration-candidates.md`, Tier 1 #1).
It builds on v1 (raster and basemap proxy and cache), which is on `main` in all four codebases. v1
spec: `docs/superpowers/specs/2026-06-27-tilecache-v1-raster-basemap-proxy-design.md`. v3 (PMTiles ETag
range-serving) is a separate later spec and is out of scope here.

This design was reviewed against correctness, the trust boundary, plan quality, and codebase fit before
finalizing, and every finding is folded in below.

## 1. Goal

Let the owner prewarm a manual cruising bounding box into the shared cache before leaving internet, so
the dashboard renders that area offline at sea, and optionally keep a small radius around the vessel
warm when it travels outside the prewarmed box. Writes stay bounded so a microSD card is not worn out.

## 2. Scope, phased

This is one spec built in two phases so the high-value, lower-risk path lands and can be boat-tested
before the continuous-warm complexity.

- Phase A (the prewarm box): the shared `tilesInBbox` helper and the shared inverse projection, the
  container warm-job engine with server-side cap enforcement and box pinning, the admin gate and the
  plugin warm and config routes, the on-demand per-source average for the estimate, and the webapp
  prewarm panel with the estimate gate.
- Phase B (off-plan position-warm): the plugin position-warm loop, its throttle and offline backoff,
  its warm concurrency sub-budget, and the panel toggle and settings.

Out of scope: v3 PMTiles range-serving and the block cache; any keyed or credentialed upstream (the
container holds no long-lived secret, per v1 section 9).

## 3. Locked decisions

- Single input, single source of truth: a webapp map panel in `signalk-binnacle` is the only input
  surface. The companion plugin is the only source of truth, persisting the box and the settings,
  running the position-warm loop, and admin-gating every write. The container is a dumb warm executor.
  There is no bbox field in the plugin `schema()`, so there is no second surface and no drift.
- Prewarm versus cap: estimate, and refuse or clamp upfront, in the panel; AND enforce the cap
  server-side in the container, so a direct POST cannot exceed it.
- The `/warm` wire contract is compact: `{ sources, bbox, minzoom, maxzoom }`. The plugin estimates
  with the shared `tilesInBbox`; the container enumerates lazily with the same inverse formula, so the
  estimate and the warm agree (a boundary-tile difference is harmless, see section 4), the wire stays
  small, and position-warm posts a tiny bbox through the same one route.
- Off-plan position-warm: a small radius around the vessel, throttled, LRU-bound, default OFF, opt-in.
- The prewarmed box is pinned (eviction-exempt). Position-warm tiles are unpinned and LRU-bound.

## 4. The shared `signalk-binnacle-chart-sources` package

Add a Web Mercator inverse and a tile enumerator, mirroring the existing `webMercatorTileBounds` (tile
to bbox) helper. Unlike the forward direction, the inverse does NOT need to be bit-exact across the TS
and the Rust. The forward pair must agree because its bbox feeds the WMS and arcgis `BBOX=` request and
the cache key; the inverse only selects which integer tiles to enumerate, and those tiles then flow
through the same forward `expand_upstream` and produce the same cache key. The estimate is an
upper-bound gate and the container hard-stops at the cap (section 5), so a boundary-tile difference
between the TS estimate and the Rust enumeration is harmless. This is a normal same-formula parity test,
not a bit-exact obligation.

- `tileForLngLat(lng, lat, z): { x, y }`: the standard slippy-tile floor. This is NEW math;
  `mercator.ts` today has only `webMercatorTileBounds` (the forward direction). The Rust container
  carries the same formula.
- `tilesInBbox(source, bbox, zoomRange): { z, x, y }[]` (and a `tileCountInBbox` for the estimate):
  clamps the zoom range to `[source.minzoom, source.maxzoom]`, clips the bbox to `source.bounds` when
  present and to the Web Mercator latitude limit (about plus or minus 85.0511 degrees), and rejects an
  antimeridian-crossing box (`minLng > maxLng`) in v2.

The package stays data and pure helpers only (no MapLibre, no Signal K, no Node or browser APIs), and
both consumers import the one definition. The package must be published to npm and both consumers moved
off the `file:` link before release (this is already step 1 of the v1 release sequence); the new export
ships in that publish, with the dependency ranges bumped.

## 5. The container `tilecache` crate

A warm-job engine added to the existing crate, reusing the v1 seams (the fetcher, the cache, the
per-kind `expand_upstream`, the response builder, the SSRF guards). No parallel fetcher.

### Routes

- `POST /warm { sources: string[], bbox, minzoom, maxzoom }`: validate each source id against
  `state.sources` (404 an unknown id), clamp the zoom range to each source's `[minzoom, maxzoom]`,
  validate the bbox (finite, `minLng < maxLng`, latitude within the Mercator limit), and hard-cap the
  projected tile count (reject an absurd payload, defeating an enumeration denial of service). Enumerate
  lazily with the same inverse formula and fetch each tile through the existing
  `get_tile` path (single-flight coalescing, the egress semaphore, the negative-cache skip, the body
  cap, and the content-type validation all apply unchanged). Returns a `jobId`.
- `GET /warm/:jobId`: `{ total, done, skipped, bytes, errors, state }` where `state` is
  `running | done | cancelled | capped | error`. The job registry is in memory, cleared on completion
  plus a TTL. An unknown `jobId` is `404` (the caller treats it as gone).
- `POST /warm/:jobId/cancel`: cooperative, checked between tiles.
- `GET /cache/stats`: extend with a per-source average computed on demand,
  `SELECT source, AVG(bytes) FROM tiles WHERE status = 200 AND blob IS NOT NULL GROUP BY source`. This
  excludes the negative-cache rows (which would understate the average and let a warm exceed the cap),
  and it avoids a running counter, which is eviction-unsafe because `evict_to` is a windowed bulk
  delete with no per-source deltas. `stats` is called rarely, so the on-demand aggregate is cheap.

### Cap enforcement and pinning (the core correctness fix)

v1's `store_200` calls `cache.evict_to(cap_bytes)` after every put; that is eviction, not stop-storing.
A naive warm over the cap would silently evict LRU rows, including the very tiles it just warmed or the
prewarmed box, which is the thrash this milestone must prevent. So the warm path is different from the
live-proxy path:

- The warm path does an explicit pre-store check: if `current_total_bytes + blob_len > cap_bytes`, it
  stops storing, marks the job `capped`, and does NOT call `evict_to`. A warm never evicts.
- The schema gains a `pinned` flag (a column, with a schema-version bump and the v1 drop-and-recreate
  upgrade path). A prewarm-box tile is stored pinned. `evict_to` excludes pinned rows from eviction, so
  position-warm tiles and live-proxy churn can never evict the box. Pinned bytes still count against
  `cap_bytes`, so the budget stays honest.
- Position-warm tiles are stored unpinned and are subject to normal LRU eviction within the cap.
- Warm puts are batched per warm in a transaction to cut per-statement overhead on the Pi microSD,
  which is safe under the v1 WAL and `synchronous = NORMAL`.
- A separate, smaller warm concurrency budget bounds the warm fetch fan-out below the shared
  `EGRESS_CONCURRENCY` (8 in `state.rs`), so a large warm cannot starve interactive tile reads.

## 6. The companion plugin

- Persist the box and the settings (the bbox, the selected source ids, the zoom range, and the
  position-warm settings) as a JSON file under `app.getDataDirPath()` (the crows-nest route-draft-budget
  precedent), NOT `schema()` and NOT `savePluginOptions` (which would surface the values in the schema
  config screen and create a second input surface). The typed server API exposes no applicationData write
  method, so a plugin data file is the persistence seam.
- Port the admin gate. The plugin has no auth today; `registerWithRouter` mounts plain unauthenticated
  routes. Port `ensureApiAdminGate` from crows-nest (`src/status/admin-gate.ts`):
  `app.securityStrategy.addAdminMiddleware(path)`, fail-closed (the route is not mounted if the gate is
  missing), idempotent. Mount the write and config routes under a gated subtree
  (`/plugins/signalk-binnacle-companion/api/...`), kept separate from the open read tile and style
  routes that v1 already serves. On an unsecured Signal K server every client is treated as admin,
  which is the standard Signal K behavior and is stated in the spec.
- Routes:
  - `POST /api/prewarm { bbox, sources, minzoom, maxzoom }` (admin): persist the box, forward a `/warm`
    to the container, and return the `jobId`.
  - `GET /api/prewarm/status/:jobId` (admin): proxy the container `/warm/:jobId`.
  - `POST /api/prewarm/cancel/:jobId` (admin): proxy the cancel.
  - `GET|POST /api/prewarm/config` (admin): read and write the box and the position-warm settings.
  - `GET /api/cache/stats` (admin, read-only): proxy the container stats for the estimate.
- Phase B, the position-warm loop: subscribe to `navigation.position`; when position-warm is enabled,
  the vessel is outside the prewarmed box, and it has moved more than the configured threshold since the
  last warm, build a small bbox around the position at the configured zooms and `POST /warm`. Throttle:
  an interval of at least 60 seconds, a small tile cap (about 16) enforced by the bbox size and the
  zoom range, zoom plus or minus one around a configured base. Back off when a warm returns all-errors
  (there is no direct internet-up signal; the container being healthy only means the container is up),
  so an offline passage does not fire roughly 16 fetches each blocking on the egress timeout every
  interval. Unsubscribe from `navigation.position` in `doStop`.
- No auto re-warm on start: the prewarmed box tiles are pinned and durable on the volume.

## 7. The webapp prewarm panel

Designed by the UI/UX team (`signalk-ui-designer` plus a second reviewer), consistent with the existing
`signalk-binnacle` panels: the same control primitives, design tokens, themes, section layout, label
voice, and spacing, in the existing SlideOver shell.

- Feature-detected: shown only when the companion is present, reusing `detectCompanion`
  (`src/shared/map/companion.ts`). A solo install never shows it.
- Gated in the UI by the read and write token (`writeBlocked === false`, or an unsecured server);
  hidden or read-only otherwise. The authority gate is the server-side admin gate in section 6; the
  client check is only to avoid showing a control that will 401.
- Draw the box with `TerraDrawRectangleMode`. Only LineString, Point, and Select modes are wired today
  in one Terra Draw instance (`route-edit.ts`); the panel uses its own panel-scoped draw instance so it
  does not conflict with the route editor.
- Source checkboxes from the shared registry; zoom min and max controls.
- A live estimate, `tileCountInBbox` times the per-source average bytes from `/api/cache/stats`, shown
  against the free cap; Prewarm is disabled while the estimate exceeds the free cap, with copy that the
  estimate is a ceiling (a warm negative-caches 404s at zero bytes, so the real footprint is smaller).
  Unit-bearing fields (the byte estimate, and in phase B the move threshold and the radius) follow the
  server unit preferences through the shared `UnitField`, never a hardcoded nautical-mile or byte unit
  or a panel-local toggle.
- Prewarm posts to the plugin, polls the status, shows a progress bar, and offers cancel. If a poll
  gets a `404` (the container restarted and lost the in-memory job), the panel treats the job as gone
  and offers a re-warm.
- Phase B: a position-warm toggle plus the radius and the throttle, persisted via `/api/prewarm/config`.

## 8. Architecture and trust rules (unchanged from v1, restated)

- The Signal K read (the vessel position for position-warm) stays in the JS plugin; the container never
  reads Signal K and stays tokenless and Signal K agnostic (the warm takes explicit geometry, never a
  Signal K path). The browser reaches tiles only through the plugin route; `signalkAccessiblePorts`
  keeps the container port off the boat LAN.
- The warm path introduces no new SSRF or open-URL hole: it is allowlist-keyed by source id, resolved
  against `state.sources`, and routed through `expand_upstream` and the guarded fetch (the literal-IP
  guard, the guarded resolver, redirects off, the body cap, and the content-type validation), exactly
  like the live proxy. There is no client-supplied URL.
- The container serves bytes and a stale marker; it never decides what is safe to show. The trust
  boundary stays in the webapp.
- Units are SI internally; convert only at the display edge, following the server unit preference.

## 9. Testing

- Package: `tileForLngLat` against known slippy-tile values; `tilesInBbox` and `tileCountInBbox` counts
  against known z and bbox cases; the zoom clamp, the bounds clip, and the antimeridian rejection.
- Container (Rust, `tower::ServiceExt`): warm enumerate and fetch and store, progress accounting, the
  cancel between tiles, the `capped` state (a warm that would exceed the cap stops and does not evict),
  pinning (a pinned box tile survives an `evict_to` that drops unpinned tiles), the per-source on-demand
  average excluding negative-cache rows, the zoom and bbox and tile-count validation, and the warm
  concurrency sub-budget. `cargo clippy --workspace --all-targets -- -D warnings`, the release build,
  and the image build green.
- Plugin (node --test): the admin gate (route not mounted without a security strategy, mounted and
  enforced with one), the prewarm and config routes forwarding to a stub container, the applicationData
  persistence, and in phase B the position-warm loop (the outside-box trigger, the move threshold, the
  throttle, the all-errors backoff, and the `doStop` unsubscribe). `npm run typecheck`,
  `npm run lint`, `npm run build` green.
- Webapp (vitest): the estimate gate enabling and disabling Prewarm, draw-to-bbox, the status poll and
  the 404 re-warm path, the feature-detect hide, and the unit-preference formatting. `npm run check`,
  `npm run lint`, `npm run build` green.

Boat-only (cannot run at the desk): prewarm a box on the boat and confirm it renders offline with the
internet pulled; confirm a pinned box survives a position-warm session; confirm a solo `signalk-binnacle`
install is unaffected.

## 10. Build and release order

1. The shared package: `tileForLngLat`, `tilesInBbox`, `tileCountInBbox`, and the tests. Publish to npm
   (already the v1 release step 1) and bump both consumers' dependency ranges.
2. The container: the warm-job engine, the cap enforcement, the pinning and the schema bump, the
   on-demand average, and the validation. Rebuild and republish the tilecache image; pin the new tag in
   `DEFAULT_TILECACHE_TAG`.
3. The plugin: the admin gate, the applicationData persistence, the prewarm and config routes, and
   (phase B) the position-warm loop.
4. The webapp: the prewarm panel (UI/UX team), the estimate gate, and (phase B) the position-warm
   settings.
5. Docs and release per the SignalK plugin pre-push checklist: CHANGELOG entries, the README "What's
   New", and the version bumps across the package, the plugin, and the webapp.

## 11. Decisions in force

- One spec, two phases (box first, then position-warm).
- Compact `/warm` bbox contract with a shared TS and Rust inverse formula (same-formula parity, not
  bit-exact, because the container hard-stops at the cap); one route covers prewarm and position-warm.
- Estimate and refuse upfront in the panel AND enforce the cap server-side; a warm never evicts.
- The prewarmed box is pinned and eviction-exempt; position-warm is unpinned and LRU-bound.
- The panel is the single input; the plugin (applicationData) is the single source of truth; the
  container is a dumb executor.
- The admin gate is ported from crows-nest, fail-closed, gating only the write and config routes.
