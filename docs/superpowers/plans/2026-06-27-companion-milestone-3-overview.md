# Milestone 3 Decomposition Overview: the local geodata pipeline and LocalProvider

> Companion to the detailed plans. This document locks the subsystem split, the
> shared GeoPackage store schema (the contract between the prep pipeline and the
> runtime), and the build sequence. It is not itself a task list.

**Spec:** `docs/superpowers/specs/2026-06-27-companion-offline-router-migration-design.md`,
sections 5 (provider abstraction), 6 (offline geodata pipeline), 8 (parity), 9
(deployment), 11 (testing), 14 (build sequence).

**Decision in force:** the ENC distribution gate is resolved to Option A,
pipeline-only (`docs/superpowers/decisions/2026-06-27-enc-distribution-model.md`).
Chart data is never bundled; the owner downloads NOAA ENC cells per region and runs
prep locally.

## Why three plans, not one

The spec's Milestone 3 covers three subsystems with different runtimes, different
test prerequisites, and a single contract between them (the per-region GeoPackage
store schema below). Each is planned and shipped on its own.

- **3A. Runtime `LocalProvider` (Rust).** Reads a per-region GeoPackage store with
  `rusqlite` (bundled SQLite, R-tree) and the pure-Rust WKB decoder proven in the
  Milestone 1.5 storage spike, and implements the engine's `Provider` trait. No
  GDAL. Fully testable on this Pi today against synthetic fixtures, with no real
  ENC or OSM data required. This is the unblocking core: it lets the router replace
  `EmptyProvider` and route over real geometry.
  Plan: `2026-06-27-companion-milestone-3a-localprovider.md`.

- **3B. Offline prep pipeline (`container/prep/`, GDAL-heavy, batch).** Turns NOAA
  S-57 `.000` cells, OSM water and land polygons, and admin-0 boundaries into the
  store schema below. GDAL is allowed here and only here. Not resident, not shipped
  in any image or npm tarball. Testing needs GDAL plus a real ENC cell and an OSM
  extract, so this is planned in detail when those inputs are staged on the Pi.
  Outline below; detailed plan deferred.

- **3C. Data-parity harness.** On sample regions, compares `LocalProvider` output
  against captured online outputs, asserting the load-bearing invariants from spec
  section 8 (identical `inEncDeep` and drying-as-land classification, and the
  safety invariant). Depends on 3A and a real region produced by 3B. Outline below;
  detailed plan deferred.

Sequence: 3A first (buildable now), then 3B once ENC and OSM inputs are staged,
then 3C once a real region store exists.

## The shared contract: per-region GeoPackage store schema

One GeoPackage file per region, EPSG:4326 (WGS84, lon/lat), opened read-only with
`immutable=1`. 3B produces exactly this; 3A (and its synthetic fixtures) consume
exactly this. Coordinates are stored in WKB axis order X then Y, which is
longitude then latitude, matching the engine's `Ring = Vec<[f64; 2]>` as `[lon, lat]`.

Standard OGC GeoPackage metadata tables: `gpkg_spatial_ref_sys`, `gpkg_contents`,
`gpkg_geometry_columns`. Every feature table has an R-tree index named
`rtree_<table>_<geomcolumn>` over the geometry bounding boxes.

Feature tables:

| Table | Columns | Maps to | Notes |
|-------|---------|---------|-------|
| `enc_depth_areas` | `fid INTEGER PRIMARY KEY`, `geom BLOB NOT NULL`, `band TEXT NOT NULL`, `drval1 REAL`, `drval2 REAL` | `ChartedAreas.depth_areas` | One row per ENC DEPARE/DRGARE polygon. `band` is one of `overview general coastal approach harbour berthing` (S-57 DSID usage band 1 to 6). `drval1` to `DepthRange.shallow_meters` (negative is a drying height), `drval2` to `DepthRange.deep_meters`. |
| `enc_land_areas` | `fid INTEGER PRIMARY KEY`, `geom BLOB NOT NULL`, `band TEXT NOT NULL` | `ChartedAreas.land_areas` | One row per ENC LNDARE polygon, same `band` values. No depth. |
| `osm_water` | `fid INTEGER PRIMARY KEY`, `geom BLOB NOT NULL` | `TileWater.water` | OSM water polygons clipped to the region. Outer ring then island holes. |
| `boundaries` | `fid INTEGER PRIMARY KEY`, `geom BLOB NOT NULL`, `country_id TEXT NOT NULL` | `RingPolygon` via `foreign_rings` | admin-0 country polygons. `country_id` is the admin-0 identifier the request's `homeCountryId` is compared against. |

`Provider` trait mapping (engine `container/engine/src/types.rs:154-163`):

- `charted_areas(band, bbox)` queries `enc_depth_areas` and `enc_land_areas` for the
  given `band` whose geometry bbox overlaps `bbox` (via the R-tree), decodes each
  geometry, and returns `Some(ChartedAreas { depth_areas, land_areas })`. It returns
  `Some` on a successful query even when zero rows match (a present-but-empty store
  reads as no-coverage, not a fetch failure), and `None` only on a SQL or decode
  error (a genuine fetch failure). This mirrors the `EmptyProvider` reasoning already
  in the router.
- `tile_water(bbox)` queries `osm_water` overlapping `bbox`, returning
  `Some(TileWater { water })` on success (empty allowed), `None` only on error.
- `foreign_rings(bbox)` queries `boundaries` whose `country_id` differs from the
  provider's configured home country and that overlap `bbox`, returning the decoded
  rings. With no home country configured it returns an empty vector.

The `usedTileWater` honesty signal is unchanged: the engine computes it from these
inputs exactly as today (`inEncDeep` from `shallow_meters >= contour`, drying-as-land
from `shallow_meters < 0`, spec lines 188-191). `DRVAL1`, `DRVAL2`, and the drying
sign are load-bearing values, not metadata (spec lines 299-303).

## 3B outline (deferred detailed plan)

Artifact `container/prep/`, run by the owner per region, GDAL allowed, never resident.

1. ENC: read NOAA `.000` cells with the GDAL S-57 driver, options `RECODE_BY_DSSI`,
   `SPLIT_MULTIPOINT`, `ADD_SOUNDG_DEPTH`, `RETURN_PRIMITIVES`. Read object classes
   DEPARE, DRGARE, LNDARE, WRECKS, UWTROC, OBSTRN. Group cells by DSID navigational
   purpose (usage band 1 to 6) into the six `band` values. Apply overlapping-cell
   precedence and use M_COVR coverage to distinguish nodata from open water.
   Normalize to the `ChartedAreas`/`DepthRange` contract: `DRVAL1` to `shallow_meters`
   (keep the negative drying sign), `DRVAL2` to `deep_meters`, carry `QUASOU`.
2. Water: ingest OSM water and land polygons from the osmdata.openstreetmap.de split
   product, clipped to the region, into `osm_water`.
3. Boundaries: ingest admin-0 polygons into `boundaries` with `country_id`.
4. Output: one GeoPackage per region matching the schema above, with an R-tree on
   every feature table, on the NVMe bind mount.

Validation gate before building on it (spec lines 358-359): a cell-versus-ArcGIS
validation of the GDAL S-57 prep output for one region.

Open question to resolve at 3B planning time: whether prep is Python plus the GDAL
CLI (`ogr2ogr`, `gdal` Python bindings) or a Rust binary linking system GDAL. Either
is fine because prep is non-resident; pick at plan time based on the S-57 grouping
and precedence logic, which is easier to express in Python.

## 3C outline (deferred detailed plan)

Depends on 3A and one real region store from 3B.

1. Cell-versus-ArcGIS validation harness for the S-57 prep output (also the 3B gate).
2. Data parity: on sample regions, run `LocalProvider` and compare against captured
   online ArcGIS/OpenMapTiles outputs for the same areas. Shoreline disagreement
   between the osmdata water polygons and the online `water` layer is expected and
   documented, not a failure. The load-bearing assertions (spec lines 299-309):
   - `inEncDeep` and drying-as-land classification are identical per sample between
     local and online ENC.
   - The safety invariant: a leg the online path flags unsafe must not become
     unflagged on the local path without an explicit, logged reason.
3. Plugin integration test (spec lines 360-362): the `signalk-container` runtime
   guard, `ensureRunning`, `resolveContainerAddress`, and the crows-nest in-process
   fallback when the companion is down.
