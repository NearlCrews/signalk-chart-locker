# Changelog

All notable changes to this project are documented here. The format follows Keep a
Changelog, and the project adheres to Semantic Versioning. The project is pre-release, so
everything below is unreleased.

## [Unreleased]

### Changed

- Reorganized the container Rust crates into one Cargo workspace (`container/Cargo.toml`) sharing a
  lock, a target directory, and the root `.cargo/config.toml`, so the x86_64 FMA-off determinism
  flag applies to every crate. Extracted the duplicated GeoPackage and WKB decoder into a shared
  `binnacle-gpkg` crate used by both `localprovider` and `storage-spike`, and the router image is
  now a single workspace build.
- Split the engine orchestrator: the water index and the endpoint snapping moved into
  `water_index.rs` and `snap.rs`, and the navigable-grid build into per-stage helpers, with no
  change to routing output (the parity corpus stays green). Efficiency work in the same area: a
  borrowed water index with no per-route ring clones, packed grid masks, fewer per-row deadline
  syscalls, and pre-sized buffers.
- The offline prep tool is now data-driven (single sources for the store schema and the ENC layer
  ingests), the router runs its blocking store-open and route off the async executor via
  `spawn_blocking`, and the `localprovider` reader caches its prepared statements and queries depth
  and land through typed paths.

### Fixed

- The prep tool no longer writes a spurious `keep` column into `osm_water` (the table is now
  geometry-only per the store contract), and it validates the boundaries country field.
- The data-parity harness filters local depth areas by band (a multi-band store could otherwise
  produce a false PASS) and fails loud on an `ogrinfo` error instead of silently treating it as no
  coverage.

### Added

- The Signal K companion plugin: a lifecycle that resolves the `signalk-container`
  manager, waits for the container runtime, launches the managed Rust router container
  with `signalkAccessiblePorts`, and publishes the in-process route-on-water bridge on
  `globalThis.__signalk_binnacle_routeOnWater`.
- The Rust router container service with `/health` and `/regions`, built multi-stage into
  a distroless image with a binary healthcheck.
- A storage tracer spike under `container/storage-spike` that proves Rust with `rusqlite`
  (bundled SQLite, R-tree) can open an offline OGC GeoPackage read-only, run an R-tree
  bounding-box query, and decode the GeoPackage geometry and WKB with a pure-Rust decoder
  on aarch64, with no GDAL, SpatiaLite, GEOS, or PROJ linked.
- The routing engine under `container/engine`: a Rust hand-port of the crows-nest channel
  router (geometry, path simplify, A*, the navigable grid, and the orchestrator), proven
  bit-for-bit against the TypeScript reference on a 17-case replay corpus.
- The `POST /route-on-water` endpoint on the router container: it deserializes a channel
  route request, runs the routing engine over the data provider, and returns the engine's
  route or decline as a stable wire result. The in-process bridge now forwards the caller's
  request to this endpoint, parses the result, and falls back to a `router-unavailable`
  decline on any transport failure rather than throwing or inventing a route. Until the
  local geodata store lands, the provider holds no charted water, so every request declines
  honestly as `no-coverage`.
- The `LocalProvider` region-store read path under `container/localprovider/`: reads an
  offline OGC GeoPackage via `rusqlite` (no GDAL or SpatiaLite), answers the engine's
  `charted_areas`, `tile_water`, and `foreign_rings` queries with R-tree bounding-box
  lookups, and decodes geometry with a pure-Rust WKB decoder. The router container now
  selects `LocalProvider` when `BINNACLE_REGION_STORE` names a store path, falls back to
  `UnavailableProvider` (declines `fetch-failed`) on an open error, and uses `EmptyProvider`
  (declines `no-coverage`) when no store is configured.
- The offline geodata prep tool under `container/prep/`: a pinned-GDAL container that reads
  NOAA ENC S-57 cells and admin-0 and OSM sources and writes one per-region GeoPackage in the
  `LocalProvider` schema, with R-tree indexes and the usage band taken from the ENC cell name.
  GDAL stays confined to this prep image, so the runtime image carries none of it. ENC and
  chart data are downloaded by the owner per region and are never bundled.
- The Milestone 3C data-parity harness under `container/prep/data_parity.py`: it samples a grid
  of points across a region and compares the local store's `inEncDeep` and drying-as-land
  classifications against the live NOAA ENC Direct service. Verified on San Francisco Bay (NOAA
  cell US5CA13M): every point covered by both sources agreed, confirming the local GDAL S-57
  prep produces depth classifications identical to NOAA's own lineage for the same charts.

### Changed

- Engine internals consolidated: a single deadline-clock module and one nautical-mile
  constant shared across the modules, one `union_bbox`, and the water index now reads the
  per-band charted areas directly rather than through an intermediate copy. The endpoint
  snap walks only the Chebyshev ring perimeter instead of the full square. All of this
  preserves the proven parity.

### Fixed

- The router declines cleanly instead of panicking when the bbox anchor list is empty.
- The navigable-grid scanline sort is total, so a non-finite coordinate sorts
  deterministically rather than panicking.
- The parity harness checks the engine's queried bounding box against the captured one
  within a small ulp tolerance, so a `route_bbox` divergence is reported directly.
