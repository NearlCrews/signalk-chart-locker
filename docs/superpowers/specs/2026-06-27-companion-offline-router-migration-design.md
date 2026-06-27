# signalk-binnacle-companion: offline channel-router migration (v1 design)

Date: 2026-06-27
Status: draft, revised after review

## 1. Summary

Stand up `signalk-binnacle-companion` as the first member of a polyglot container
family for the boat. Native Signal K plugins run JS/TS inside the server process;
a container lets us run any runtime alongside it. v1 lifts the heaviest,
event-loop-blocking code out of `signalk-crows-nest`, the channel router, into a
Rust service in a container, and gives it a fully local geodata store (local
OpenStreetMap water polygons and local NOAA ENC chart cells) so the routing
geometry no longer depends on live calls to openfreemap and the NOAA ArcGIS
service.

The companion is a thin Node Signal K plugin plus a container image, in one repo.
The plugin owns the Signal K trust boundary and lifecycle. The container owns the
heavy compute and the multi-gigabyte datasets. `signalk-crows-nest` keeps its
route-draft endpoint, the OpenRouter call, the Signal K reads, the budget and
admin gate, and the entire safety and honesty layer. It delegates only the
"route this passage on water" geometry to the companion, through an in-process
bridge, with an in-process fallback when the companion is absent.

Scope honesty: full offline plus a native rewrite plus a new plugin and repo is
several sequenced milestones, not one change. Section 14 decomposes it. The
routing geometry goes offline in v1; the depth and hazard verdict (the safety
check) stays online in v1 and is forced to declare itself unverified when offline.
Moving the verdict offline is the next milestone, and it reuses the local ENC
store this work builds.

## 2. Background and motivation

The route-draft pipeline in crows-nest (`src/route-draft/endpoint.ts`) is: take a
plain-language request, ask OpenRouter for turning waypoints, re-route the
geometry through an owned A* channel router so legs follow water, then run a
deterministic per-leg safety check, all inside one 50-second deadline.

Two problems v1 addresses:

1. The channel router (`src/route-draft/channel-router/nav-grid.ts`,
   `astar.ts`, `channel-router.ts`, plus its dependency closure, roughly 1,800 to
   2,200 LOC of behavior) is synchronous CPU that blocks the Signal K event loop.
   The code is full of manual yield-less deadline probes (`DEADLINE_CHECK_CELLS`,
   `DEADLINE_CHECK_INTERVAL`, `overDeadline()` in every loop) precisely because it
   cannot await. A native implementation in a separate process never stalls the
   server.
2. The routing geometry depends on live public HTTP: openfreemap vector tiles for
   water (with code that already handles the CDN build path aging out and
   returning 404), and NOAA ArcGIS ENC Direct for charted depth and land. A boat
   at sea has no internet. A local store removes that dependency for the geometry.

What v1 does not fix, and says so: the safety verdict still calls ENC, EMODnet,
and Overpass online (`safety-check.ts`), so offline it cannot verify depth or
hazards. v1 makes that honest rather than silent (section 8).

## 3. Architecture

```
Binnacle / Freeboard ──HTTP (future, admin-gated)──┐
                                                    ▼
  signalk-server  ◄─►  signalk-binnacle-companion (Node plugin, in-process)
                          │  ensureRunning(signalkAccessiblePorts) ─► signalk-container ─► Docker
                          │  resolveContainerAddress ─► Rust router container (private addr)
                          │  exposes globalThis.__signalk_binnacle_routeOnWater
                          ▼
  signalk-crows-nest (route-draft) ──in-process call──► routeOnWater bridge
```

Settled facts from research against signalk-server 2.28.0 and the live host:

- Signal K core has no native managed-container feature. The de-facto standard is
  the `signalk-container` plugin (installed here, v1.20.2). `signalk-grafana` and
  `signalk-questdb` already use it on this box, so the pattern is proven here.
- The companion plugin launches the Rust container with `ensureRunning`, declaring
  `signalkAccessiblePorts: [<router-port>]` and passing no manual `ports` or
  `networkMode` (the manager owns networking). It reaches the container through
  `resolveContainerAddress(name, port)`, which returns a loopback address when
  Signal K is bare metal (the case here) or a shared Docker network DNS name when
  Signal K is itself containerized.
- The container stays tokenless and Signal K agnostic. Only the in-process plugin
  talks to it.

### Caller integration is in-process, not HTTP

crows-nest runs server-side. An HTTP call to `/plugins/signalk-binnacle-companion/...`
carries no cookie and no token, and signalk-server gates `/plugins` behind
`adminAuthenticationMiddleware`, so a credential-less loopback call fails closed
when security is enabled (it is here, `tokensecurity`). The companion therefore
exposes an in-process bridge on `globalThis.__signalk_binnacle_routeOnWater`,
mirroring how `signalk-container` exposes `globalThis.__signalk_containerManager`.
crows-nest resolves it, awaits a `whenReady()`, and calls it directly. The plugin
behind that bridge proxies to the container via `resolveContainerAddress`. This
removes the auth problem, the network hop, and the serialization round trip.

A browser-facing `registerWithRouter` surface is explicitly out of scope for v1
(no browser caller exists yet). If one is added later, it must call
`securityStrategy.addAdminMiddleware('/plugins/signalk-binnacle-companion/...')`
and fail closed if that is unavailable, exactly as crows-nest gates its own
`/api` routes today, because plugin routers receive no authentication by default.

### Dependency on signalk-container is a runtime guard, not metadata

`signalk.requires` is app-store enrichment only; it does not gate install, start
order, or runtime presence, and plugins start in parallel. The real dependency is
a runtime guard: resolve `globalThis.__signalk_containerManager`, await
`whenReady()`, check `getRuntime()`, and call `setPluginError` and bail cleanly if
absent. Keep `signalk.requires` for the listing and add a `peerDependencies` range
on signalk-container.

### Why Rust, and what it is not

The A* hot loop wants a native, allocation-light, GC-free language running off the
Signal K event loop in its own process. That is the reason for Rust, not crate
convenience. The mature geospatial crates are mostly the wrong tool here: `geo`'s
`Contains` and `Intersects` use winding plus robust-predicate boundary semantics
that will not match the TS even-odd ray cast in `pointInRings` or the
orientation-sign proper-crossing in `segmentsCross`, and `pathfinding`'s A* breaks
equal-cost ties differently and does not implement the corner-cut rule or the step
penalty. So the engine is hand-ported, roughly mechanically, from the TS. Crate
use is restricted to `rusqlite` (with the `bundled` feature, which statically
compiles SQLite with the R-tree module) plus a small WKB decoder; the uniform-grid
bucket index (`WaterIndex`) is ported as-is rather than swapped for `rstar`.

## 4. Repository and artifact layout

One repository, `signalk-binnacle-companion`, ships coordinated artifacts. This
does not violate the "one plugin, modular files, never multiple npm packages"
rule: there is exactly one npm package (the plugin); the containers are build
artifacts, not npm packages.

```
signalk-binnacle-companion/
  package.json            # the Signal K Node plugin (one npm package)
  src/                    # plugin TypeScript: lifecycle, ensureRunning config,
                          #   signalk-container runtime guard, the in-process
                          #   routeOnWater bridge, the container client, schema,
                          #   status
  container/
    Dockerfile            # runtime image: near-static Rust binary, no GDAL,
                          #   no SpatiaLite, distroless or scratch base
    router/               # Rust crate: A*, grid, geometry, providers, the
                          #   container-internal HTTP endpoint the plugin calls
    prep/                 # offline geodata prep (GDAL/ogr2ogr batch), produces
                          #   per-region GeoPackage stores. Separate image.
  docs/
```

The prep image (GDAL-heavy) is a second, separately versioned artifact. It is what
the boat owner runs once per region to build the local data, either as a one-shot
`signalk-container` `runJob` or on a dev machine. It is published to GHCR with its
own tag, or kept dev-only, decided at the operator-workflow milestone.

## 5. The container router service and its contract

A small HTTP service inside the container, called only by the plugin over the
private resolved address. The contract mirrors the existing in-process
`routeChannel` signature exactly so crows-nest swaps caller for caller and the
honesty layer consumes the result unchanged.

- `POST /route-on-water`
  - Request: `{ from, to, anchors[], corridor?, draftMeters, safetyMarginMeters,
    standoffNm, homeCountryId?, deadlineMs }`.
    - `from` and `to` are the route endpoints; `anchors[]` is the full LLM
      waypoint list that sizes the bbox; `corridor?` is the optimize polyline.
    - `homeCountryId?` selects border-aware routing: the container owns the
      country-boundary dataset and computes foreign-water rings over its own
      padded bbox (`routeBbox(anchors, BBOX_PAD_METERS)`), reproducing the
      behavior the TS got from a `foreignRings` closure. The 1.4 MB
      `countries.geojson` moves into the container datasets and leaves the npm
      tarball.
  - Response: the discriminated union matching `ChannelRouteResult`:
    `{ ok: true, waypoints, usedTileWater, borderFallback } | { ok: false, reason }`,
    where `reason` is one of the six typed decline reasons keyed to
    `CHANNEL_NOTE_BY_REASON`. This is a route-level outcome, not per-leg; per-leg
    verdicts remain the safety check's job in crows-nest.
- `GET /health` for the container healthcheck.
- `GET /regions` reporting which regions have local data, so the plugin and
  crows-nest can warn or degrade when a passage leaves covered water.

Batch semantics: the service routes the single `from`/`to` pair sized by
`anchors`, matching the current call. Multi-leg batching is not introduced in v1.

Geometry is computed exactly as today: rasterize water, land, and border polygons
into a grid, multi-source clearance, one-cell erosion, largest-component selection
with expanding-ring snap, 8-connected A* with the corner-cut rule and step
penalty, RDP simplify with the per-grid epsilon, the repair pass, decimation, and
a full-resolution `routeLegsOnWater` re-check. The `usedTileWater` flag is computed
from the local ENC the same way the TS computes it (`inEncDeep` from
`shallowMeters >= contour`, drying-as-land from `shallowMeters < 0`), so the
`CHANNEL_TILE_WATER_CAVEAT` honesty signal still fires correctly.

### Provider abstraction

The engine reads geodata through a provider interface with two implementations:

1. `LocalProvider`: queries the per-region GeoPackage store (water polygons, ENC
   features, country boundaries). The v1 default and the offline path.
2. `FileProvider`: replays pre-captured geometry fixtures from disk. Used only by
   the engine-parity harness (section 8). There is no live online provider
   reimplemented in Rust: the at-sea online fallback, if ever wanted, is the
   existing crows-nest TS path behind the feature flag, and a boat offline has no
   openfreemap or NOAA anyway.

## 6. Offline geodata pipeline

Kept out of the runtime image and off the hot path.

- Prep stage (`container/prep/`, GDAL-heavy, batch, not resident):
  - ENC: read NOAA `.000` cells with the GDAL S-57 driver. This is a different
    data lineage from the ArcGIS ENC Direct service the TS consumes: raw S-57
    object classes (DEPARE, DRGARE, LNDARE, WRECKS, UWTROC, OBSTRN) with native
    attribute names and no pre-decoding, multipoint soundings, and driver options
    (`RECODE_BY_DSSI`, `SPLIT_MULTIPOINT`, `ADD_SOUNDG_DEPTH`, `RETURN_PRIMITIVES`).
    The prep must group cells by DSID navigational purpose (usage band 1 to 6) to
    reproduce the "finest first" band logic `buildNavGrid` relies on, apply
    overlapping-cell precedence, and use M_COVR coverage to distinguish nodata from
    open water, which the ArcGIS returns gave implicitly. Attributes normalize to
    the existing `ChartedAreas` and `DepthRange` contract, including the negative
    `DRVAL1` drying convention, the `DRVAL1`/`DRVAL2` depth range, and `QUASOU`.
  - Water: ingest OSM water and land polygons from the osmdata.openstreetmap.de
    split product, clipped to the region.
  - Country boundaries: ingest the admin-0 polygons for border-aware routing.
  - Output: one GeoPackage per region with R-tree spatial indexes on every queried
    table. Datasets and stores live on the NVMe bind mount, never in an image and
    never in an npm tarball.
- Runtime stage: Rust plus `rusqlite` (bundled SQLite with R-tree) and a pure-Rust
  WKB decoder. No libgdal, no `mod_spatialite`, no libgeos, no libproj in the
  runtime image, so it is a genuinely near-static binary on a distroless or scratch
  base, tens of MB. Region stores are opened read-only with `immutable=1` (not WAL,
  which a read-only mount cannot support).
- Region management: the owner selects cruising regions and runs the prep job. The
  router loads whatever regions are present and reports them via `GET /regions`.

Disk budget, transient versus resident: the global OSM water split is a multi-GB
download that unzips to roughly 2 to 2.5 GB and needs working space during the
clip, so prep has a real transient footprint. Resident regional GeoPackages plus a
typical ENC cell set land in the low single-digit GB on the NVMe. The
operator-workflow milestone decides whether we host and version pre-clipped
regional water (so the owner never stages the global file) or require the global
source on the Pi during prep.

## 7. signalk-crows-nest integration

- The route-draft pipeline keeps its endpoint, OpenRouter call, Signal K reads
  (`design.draft`, `tanks.fuel.*`, position), budget tracker, admin gate, and the
  entire honesty layer, decline-reason vocabulary, and depth-authority precedence.
  None of that crosses the boundary.
- The single in-process `routeChannel(...)` call becomes a call to the companion's
  `globalThis.__signalk_binnacle_routeOnWater` bridge with the full request from
  section 5. crows-nest computes nothing about water or ENC itself anymore on that
  path; it passes `homeCountryId` and consumes `usedTileWater` and `borderFallback`
  to drive `CHANNEL_TILE_WATER_CAVEAT`, `borderFallbackNote`, and the decline notes.
- Deadline and cancellation: crows-nest keeps the `REQUEST_DEADLINE_MS` budget and
  the `ROUTER_MIN_BUDGET_MS` gate. It passes `deadlineMs` to the bridge, and the
  container honors it as a hard internal stop independent of the connection, so an
  abandoned request cannot run the CPU forever. A router timeout maps to the
  existing `deadline` decline reason, a clean decline, not an error.
- Fallback: when the companion is absent or not ready, crows-nest falls back to the
  existing in-process router behind a feature flag, so crows-nest stays standalone
  installable and the cutover is reversible. This is named honestly: the
  event-loop-blocking code is avoided when the companion is present and the flag is
  on, not deleted. A deprecation horizon for removing the in-process path is set
  once the companion has shipped and proven out.
- Offline honesty: when the safety check's online providers are unreachable (the
  offline case), crows-nest forces the depth-unverified caveat on every leg, so an
  offline draft can never present as depth-checked. The routing geometry is offline
  in v1; the verdict is not, and the route says so.

## 8. Parity and correctness strategy

Full offline changes both the engine and the data, so byte-comparison against the
current router is impossible. Parity splits into two independent tests, which is
why the provider abstraction exists.

1. Engine parity. Capture the current TS router's actual fetched inputs (the
   per-band `ChartedAreas` and the `TileWater` rings) to JSON fixtures, and replay
   the identical geometry into both the TS router and the Rust router through
   `FileProvider`. No second live fetcher exists, so a fetch or parse difference can
   never masquerade as an engine difference. Compare:
   - The decline reason as the primary signal: it must match exactly. Decline-reason
     mismatches are classified up front into "acceptable boundary case" versus "real
     regression", because the reason depends on internal control flow (snap failure
     versus single-cell collapse versus A* miss versus re-check failure).
   - The geometry within a per-stage tolerance as the secondary signal. Bit-exact is
     unattainable: `hypot`, `asinh`, `tan`, and the distance trig differ by ULPs
     across libm implementations and against JS `Math`, and equal-cost A* tie-breaks
     can flip. The port replicates expression order exactly and disables FMA
     contraction and fast-math so the deterministic integer-grid operations stay
     reproducible. The `deadline` decline is timing dependent across languages and
     CPUs, so the corpus runs with deadlines generous enough that no decline is
     timing-induced, and the deadline path is tested separately with synthetic
     fixtures.
2. Data parity. On sample regions, compare `LocalProvider` (local OSM water, local
   ENC, local boundaries) against captured online outputs for the same areas.
   Expect systematic shoreline disagreement: the online OpenMapTiles `water` layer
   and the osmdata water polygons are different OSM-derived generalizations, so this
   is documented as expected, not a bug. The load-bearing assertions are:
   - The `inEncDeep` classification and the drying-as-land classification produce
     identical per-sample results between local and online ENC, because those drive
     `usedTileWater` and therefore the depth caveat. `DRVAL1`, `DRVAL2`, and the
     drying sign are treated as load-bearing values, not metadata.
   - The safety invariant: a leg flagged unsafe by the online path must not become
     unflagged on the local path without an explicit, logged reason.

A drafted route remains a draft to verify against official charts. The migration
must not weaken that contract, and the offline depth-unverified caveat (section 7)
is part of keeping it.

## 9. Deployment on the Pi

- Image: the runtime image is multi-stage with a Debian-slim build stage and a
  distroless or scratch runtime carrying the near-static Rust binary, multi-arch
  buildx for `linux/arm64` and `linux/amd64`, published to GHCR, no secrets baked
  in. The prep image is built and published separately (section 4).
- Lifecycle: the plugin declares the container via `ensureRunning` with
  `signalkAccessiblePorts`, CPU, memory, and pid caps, a healthcheck, and a positive
  `oomScoreAdj`. Datasets on a read-only NVMe bind mount, opened `immutable=1`; a
  separate writable cache volume; read-only rootfs with a tmpfs for scratch.
- Memory cap sizing: the algorithm itself is modest. A 250,000-cell
  (`MAX_CELLS`) grid plus its working arrays comes to roughly 10 to 20 MB, and a
  dense bbox returns 1,000 to 2,000 ENC polygons. The risk is sizing the hard cap
  below the real working set (grid arrays, the loaded polygon set, the SQLite page
  cache, and the runtime libs), which would SIGKILL the router mid-passage with swap
  disabled. The cap is computed from the worst case and pinned with margin, a first
  estimate of 512 MB to 1 GB, and load-tested against the densest region we ship
  before it is declared. The router, not Signal K, dies first by design, but the cap
  must clear the worst case or passages fail.
- Cold start: the first draft after container start otherwise pays container cold
  start plus a cold SQLite page cache inside the 50-second deadline. The plugin
  pre-triggers `ensureRunning` and a warm-up query at plugin start so the first real
  draft does not absorb that latency.
- Reachability: `resolveContainerAddress` for the plugin-to-container hop; no
  manual published port; the browser never talks to the container directly in v1.
- Offline updates: `docker save` and `docker load` from a USB stick, version tags
  pinned by digest, `docker compose pull` before leaving port. No internet assumed
  at sea.

## 10. Security and trust boundary

- The container is tokenless and Signal K agnostic. Only the in-process plugin
  talks to it, over the private resolved address.
- No OpenRouter key in the container: the LLM call stays in crows-nest. The
  container handles geometry and geodata only.
- Border logic moving into the container is deterministic geometry over a public
  dataset; crows-nest still owns the honesty wording it drives. Depth authority and
  the safety verdict stay in crows-nest.
- Hardening: non-root user, read-only rootfs, `cap-drop ALL`, `no-new-privileges`.

## 11. Testing

- Rust unit tests for grid build, clearance, erosion, largest-component, snap, A*
  with the corner-cut rule, RDP simplify, decimation, and the re-check, on synthetic
  fixtures with known-correct paths.
- The two-axis parity harness from section 8, runnable in CI on amd64 and on the Pi
  on arm64, with FMA and fast-math disabled.
- A cell-versus-ArcGIS validation of the GDAL S-57 prep output for one region before
  building on it.
- Plugin integration test: the signalk-container runtime guard, `ensureRunning`
  lifecycle, `resolveContainerAddress`, and the crows-nest in-process fallback when
  the companion is down.
- crows-nest contract test: the routeOnWater bridge client against a stub.
- A memory-cap load test on the densest shipped region.

## 12. Risks and open questions

- Scope: full offline plus a native rewrite plus a new repo and plugin is several
  milestones, not one change. Section 14 is how it stays shippable.
- Effort honesty: the port surface is the dependency closure, not three files. With
  `path-simplify.ts`, `tile-water-query.ts`, and the shared geometry
  (`sampleRhumbLeg`, `distanceMeters`, `metersPerDegreeLon`, `boundsOfRings`,
  `pointInRings`, `segmentsCross`, `orient2D`, `WaterIndex`, and the
  snap/component/decimate/re-check machinery), it is roughly 1,800 to 2,200 LOC of
  behavior to reproduce with parity.
- ENC licensing and redistribution: NOAA ENC is public, but bundling or
  redistributing cells has terms to check. The owner most likely downloads cells per
  region; we ship the pipeline, not the data. This is a gate before the local-ENC
  milestone.
- GDAL S-57 fidelity: reproducing the ArcGIS-derived `ChartedAreas` contract from
  raw S-57 (band grouping, coverage, drying sign, multipoint soundings) is the
  riskiest data step and is validated cell-by-cell.
- A* parity tolerance: defining "close enough" for a safety-adjacent path so a
  faithful rewrite is not rejected by ULP differences, nor a real regression
  accepted.
- Region data logistics: transient prep footprint versus resident store, and whether
  we host pre-clipped regional water.
- Coordinating two repos (crows-nest caller change plus the new companion) and
  release ordering.

## 13. Out of scope for v1 (later increments)

- Moving the safety check verdict offline (depth and hazard verification against the
  local ENC store this work builds). This is the natural next milestone.
- A browser-facing `registerWithRouter` surface for Binnacle, admin-gated.
- Local tile serving to Binnacle (offline basemap, bathymetry, seamarks), which the
  geodata and image pipeline here lays the foundation for.
- Weather routing and isochrones (GRIB).
- A live online provider reimplemented in Rust, and multi-region operator UX polish.
- Moving ENC POI inputs or any notes and notification outputs. Those stay in
  crows-nest.

## 14. Proposed build sequence

Milestones 1 through 3 are internal; nothing reaches the boat until the cutover at
milestone 4.

1. Repo skeleton (internal). The Node plugin, the signalk-container runtime guard
   (`globalThis.__signalk_containerManager`, `whenReady`, `getRuntime`, fail clean
   if absent), `ensureRunning` of a trivial Rust health service with
   `signalkAccessiblePorts`, and the in-process `routeOnWater` bridge stub. Proves
   the plumbing end to end on the Pi.
1.5. Storage tracer spike (internal). Prove a GeoPackage or SQLite plus R-tree bbox
   query from Rust on arm64 against a real regional sample, retiring the highest
   technical risk before the engine port.
2. Rust engine hand-port plus the engine-parity harness (internal). Port the
   closure, run the replay `FileProvider` corpus against the TS router, reach the
   parity bar in section 8.
   - Gate: the ENC licensing and redistribution decision, before milestone 3.
3. Local data (internal). The GDAL S-57 to GeoPackage prep, OSM water and boundary
   ingestion, `LocalProvider`, the cell-versus-ArcGIS validation, and the
   data-parity harness.
4. crows-nest cutover (reaches the boat). The routeOnWater bridge client, the
   feature flag, the in-process fallback, and the offline depth-unverified caveat
   enforcement.
5. Operator workflow and docs. Acquiring NOAA cells, running the clip and prep,
   landing region stores on the volume, and the prep image delivery and versioning.
6. Pi deployment hardening. Memory-cap load test on the densest region, container
   pre-warm, GHCR publish, and the offline update path.
```
