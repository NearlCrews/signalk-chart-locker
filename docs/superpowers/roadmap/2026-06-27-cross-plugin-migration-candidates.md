# Cross-plugin migration candidates for the companion container

> Date: 2026-06-27. A survey of the sibling Signal K plugins for functionality that
> belongs in the companion container, and a recommended order. Not a task list: each
> chosen target gets its own spec and plan when it is taken up.

## The charter, restated

The companion runs a polyglot Rust container alongside the Signal K server to escape the
JS/TS native-plugin sandbox. The container is tokenless, Signal K agnostic, and computes
or stores only. The trust boundary stays in the calling plugin: every LLM call, credential,
Signal K read and write, config, admin, and budget gate, and all hazard and safety wording
remain in the JS plugin. A candidate is worth moving only if it is heavy compute,
needs a native runtime the sandbox cannot host, is a large offline dataset, or wants
process isolation.

## The shape that emerged: three pillars

Reviewed against that bar, the companion is becoming a boat-wide offline data and
heavy-compute service with three pillars. Each is the same escape-the-sandbox win in a
different form: heavy compute, large offline data, or a shared persistent store, all
awkward in the per-browser, per-plugin JavaScript sandbox.

1. Geometry and routing. The channel router plus the leg-safety geometry that scores it.
   Already in flight as Milestones 2 through 4.
2. Offline tile and chart serving. A boat-wide tile cache and proxy, converging with the
   Milestone 3 local geodata store.
3. A shared local time-series store. One embedded history store that replaces the external
   QuestDB dependency for more than one plugin.

## Tier 1: clear wins

### 1. Boat-wide offline tile and chart cache and proxy (from signalk-binnacle)

The dashboard has no shared cache. Every device fetches charts and overlays live and caches
them only in its own browser, capped at 256 MB per browser, and the ServiceWorker is inert
over the plain-http boat LAN. The remote WMS and XYZ raster sources (NOAA ENC, GEBCO,
EMODnet, BlueTopo, and OpenSeaMap) have no durable offline cache at all, and the PMTiles
path carries a `cache: no-store` workaround for a browser cache bug.

Move into the container: a tokenless local tile service that range-serves PMTiles with
strong ETags (which retires the workaround), reverse-proxies and disk-caches the upstream
rasters once for the whole boat, prewarms a cruising bounding box, serves offline at sea,
and removes the per-browser cap. The browser keeps MapLibre rendering, the protocol
resolution, styling, and layer control. The container serves bytes and never decides what
is safe to show.

This is the largest standalone win. It dedupes fetch and storage across every device, makes
the raster overlays genuinely offline on a plain-http boat, and aligns with the
tile-host-first direction and the demand-driven NVMe tile-cache proxy already on the table.
It also dovetails with Milestone 3: a local ENC chart-tile service is the natural next step
there, within the no-runtime-GDAL rule and the resolved ENC distribution decision.

### 2. Channel-router leg-safety geometry (from signalk-crows-nest), with the router

After the A* port, the heaviest remaining synchronous compute in crows-nest is the
leg-safety geometry: per-leg point-in-polygon, segment crossing, and nearest-land
projection over up to roughly two hundred thousand polygon vertices on routes of fifty or
more legs. It is pure geometry and it consumes the same offline tile water and country
boundaries the router already needs, so it belongs in the same Rust crate and migrates with
the router cutover, not as separate work. The vector-tile (MVT and PBF) decode is the
router's water source and an ESM-only dependency that is awkward in the CommonJS sandbox, so
it moves with the router as well.

Follow-on, medium value: the USCG Light List store, about fifty-seven thousand aids to
navigation with a blocking JSON parse, fits the same embedded-store pattern as Milestone 3.

## Tier 2: shared infrastructure

### 3. A boat-wide local time-series store replacing external QuestDB

Two plugins depend on an external QuestDB and degrade silently when it is unavailable: the
openrouter companion's trend analyzers run band binning, nearest-sample joins, and window
reductions in QuestDB SQL, and the NMEA 2000 emitter's advisor also queries QuestDB. The
container could embed one local time-series store with bundled SQLite, matching the
no-heavy-native-libs rule, plus the windowed aggregation, and serve both. That deletes a
shared external dependency and its skip-until-the-database-recovers failure mode. Each
plugin keeps its ingestion subscriptions, prompt assembly, LLM call, budget gate, and
wording. Forward-looking: this absorbs an external service rather than extracting compute
that blocks the event loop today, since that work already runs in QuestDB.

### 4. Weather fetch, cache, and derived-product precompute (from signalk-binnacle)

The same fetch-once, cache-boat-wide, precompute shape as the tile proxy. Isobar contouring
and the wind-field texture are currently recomputed on every device. Fold them into the
tile and data service. The GPU particle simulation and the painting stay in the browser.

## What stays in JS, confirmed across the family

- signalk-nmea2000-emitter-cannon: JSON-to-JSON field mapping. The binary PGN encode and the
  CAN bus write already live downstream in canboatjs and the server. Nothing heavy, no
  dataset, no native need.
- signalk-synthetic-values: the sensor-fusion math is bounded (at most sixteen sources) and
  throttled to about one hertz per path. No interpreter, no table. The seam would cost more
  than the microseconds it saves.
- signalk-virtual-weather-sensors: network-bound, with constant-time scalar physics on a
  single snapshot at a five-second tick and no history store. The merge and physics are the
  only cleanly separable piece, worth revisiting only if a future milestone needs
  cross-language numeric parity.
- signalk-maintenance: not a Signal K plugin. It is a cloud-only repository orchestrator with
  no on-boat seam, and its one heavy workload is deliberately cloud-resident to keep it off
  the Pi.

In every case the seam is identical: geometry, data, and storage in the container, and every
network read, credential, budget and admin gate, and safety word in the plugin.

## Recommended order

1. Finish Milestone 3 (LocalProvider) and Milestone 4 (router cutover). The crows-nest
   leg-safety geometry rides along with the cutover.
2. The tile cache and proxy. Highest standalone value, and it reuses the Milestone 3 NVMe
   store and the container plumbing.
3. The shared time-series store, once the embedded-store pattern is proven by Milestone 3.

## Status note (2026-06-28)

Items 1 and 2 are complete. Milestone 3A and 3B are done; Milestone 4 is done in code on
`feat/m4-companion-cutover` in `signalk-crows-nest` (pending merge and release). Tile cache
v1 (raster and basemap proxy and cache) is on `main`; v2 (manual prewarm bounding-box warm
and throttled position-warm, bounded microSD writes) and v3 (PMTiles chart provider, Node
plugin side) are complete on `feat/tilecache-v2-v3`, pending the owner-run release. Item 3
(shared time-series store) remains the next roadmap target.
