# Changelog

All notable changes to this project are documented here. The format follows Keep a
Changelog, and the project adheres to Semantic Versioning. The project is pre-release, so
everything below is unreleased.

## [Unreleased]

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
