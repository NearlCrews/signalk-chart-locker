# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The project is pre-release, so
everything below is the initial public release.

<a id="v010"></a>

## [0.1.0] - 2026-06-28

### Added

- **Tile cache prewarm (v2).** Draw a cruising box on the chartplotter and fill the shared
  boat-wide tile cache before leaving internet coverage. A live byte estimate, gated against
  the configured cache capacity, shows how much storage the selected area and zoom range will
  use before the fill begins. The prewarmed box is pinned in the cache and never evicted;
  writes are bounded for microSD longevity. Served through a new prewarm panel in the
  Binnacle chartplotter.
- **Off-plan position-warm (v2).** An optional, throttled background fill keeps a small radius
  of tiles warm around the vessel when it travels outside the prewarmed box. Eviction is
  LRU-bounded so the position-warm is always storage-bounded and never evicts the pinned box.
- **PMTiles chart provider (v3).** The companion discovers, validates, and registers local
  `.pmtiles` archives without a plugin restart. Bounds and zoom levels are read directly from
  the archive header, the archive is validated on discovery, and each chart is served with a
  strong ETag and HTTP Range support so the browser cache works and the chartplotter can retire
  the no-store workaround on the provided path. A chart-management panel in the chartplotter
  lists the detected archives with a per-chart name and description. If the third-party
  `signalk-pmtiles-plugin` is enabled, the companion defers to it and surfaces a clear status
  rather than conflicting.
- The Signal K companion plugin lifecycle: resolves the `signalk-container` manager, waits for
  the container runtime, launches the managed Rust router container with
  `signalkAccessiblePorts`, and publishes the in-process route-on-water bridge on
  `globalThis.__signalk_binnacle_routeOnWater`.
- The Rust router container with `/health` and `/regions` endpoints, built multi-stage into a
  distroless image with a binary healthcheck.
- The routing engine under `container/engine/`: a Rust hand-port of the crows-nest channel
  router (geometry, path simplify, A\*, navigable grid, and orchestrator), proven against a
  17-case replay corpus.
- The `POST /route-on-water` endpoint on the router container: deserializes a channel route
  request, runs the routing engine over the data provider, and returns the engine's route or
  decline as a stable wire result. The in-process bridge forwards requests to this endpoint and
  falls back to a `router-unavailable` decline on any transport failure.
- The `LocalProvider` region-store read path under `container/localprovider/`: reads an offline
  OGC GeoPackage via `rusqlite` (no GDAL or SpatiaLite), answers the engine's `charted_areas`,
  `tile_water`, and `foreign_rings` queries with R-tree bounding-box lookups, and decodes
  geometry with a pure-Rust WKB decoder.
- The offline geodata prep tool under `container/prep/`: a pinned-GDAL container that reads
  NOAA ENC S-57 cells and Marine Regions EEZ and OSM sources and writes one per-region
  GeoPackage in the `LocalProvider` schema. GDAL is confined to this prep image and is never in
  the runtime image. ENC and chart data are downloaded by the owner per region and are never
  bundled.
- The Milestone 3C data-parity harness under `container/prep/data_parity.py`, verified on San
  Francisco Bay (NOAA cell US5CA13M): every sampled point agreed between the local store and the
  live NOAA ENC Direct service.
- A storage tracer spike under `container/storage-spike/` that proves Rust with `rusqlite` can
  open an offline OGC GeoPackage read-only with no GDAL, SpatiaLite, GEOS, or PROJ linked on
  aarch64.

### Changed

- Reorganized the container Rust crates into one Cargo workspace (`container/Cargo.toml`)
  sharing a lock, a target directory, and the root `.cargo/config.toml`, so the x86_64 FMA-off
  determinism flag applies to every crate. Extracted the shared GeoPackage and WKB decoder into
  the `binnacle-gpkg` crate, used by both `localprovider` and `storage-spike`.
- Split the engine orchestrator: the water index and endpoint snapping moved into
  `water_index.rs` and `snap.rs`, and the navigable-grid build into per-stage helpers, with no
  change to routing output. Efficiency work: a borrowed water index with no per-route ring
  clones, packed grid masks, fewer per-row deadline syscalls, and pre-sized buffers.
- The offline prep tool is now data-driven (single sources for the store schema and the ENC
  layer ingests), the router runs its blocking store-open and route off the async executor via
  `spawn_blocking`, and the `localprovider` reader caches its prepared statements and queries
  depth and land through typed paths.
- Engine internals consolidated: a single deadline-clock module and one nautical-mile constant
  shared across modules, one `union_bbox`, and the water index reads the per-band charted areas
  directly rather than through an intermediate copy. The endpoint snap walks only the Chebyshev
  ring perimeter instead of the full square.

### Fixed

- The prep tool no longer writes a spurious `keep` column into `osm_water` (the table is
  geometry-only per the store contract), and it validates the boundaries country field.
- The data-parity harness filters local depth areas by band (a multi-band store could otherwise
  produce a false PASS) and fails loud on an `ogrinfo` error instead of silently treating it as
  no coverage.
- The router declines cleanly instead of panicking when the bbox anchor list is empty.
- The navigable-grid scanline sort is total, so a non-finite coordinate sorts deterministically
  rather than panicking.
- The parity harness checks the engine's queried bounding box against the captured one within a
  small ULP tolerance, so a `route_bbox` divergence is reported directly.
