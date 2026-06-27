# Milestone 3B: Offline geodata prep pipeline Implementation Plan

> **Status: core implemented and verified against a real NOAA cell.** The prep tool is
> committed at `container/prep/` (`prep_region.py`, `Dockerfile`, `README.md`) and was run
> against a real downloaded NOAA ENC cell (US3EC06M) plus the Natural Earth admin-0 source. It
> produced a GeoPackage with 254 real depth-area polygons and 242 country boundaries in the
> exact 3A schema, and the runtime router read that store through `LocalProvider` and returned
> a real `ok: true` route over the bathymetry (and an honest `no-coverage` outside the cell).
> Per the Option A decision the owner downloads ENC cells; this milestone ships the pipeline,
> not the data. The DEPARE, DRGARE, and LNDARE
> paths are all verified against a real harbour cell (US5CA13M: 500 depth areas and 120 land
> areas), and multi-cell overlapping-band precedence is verified against two real overlapping
> cells (US5CA13M harbour plus US3CA52M coastal: 633 depth rows tagged 500 harbour and 133
> coastal, with the finer harbour band covering the bay interior and the coarser coastal band
> filling gaps). The cell-versus-ArcGIS validation gate is the Milestone 3C harness and passed.
> Remaining before this milestone is fully closed: OSM water ingestion at real (multi-GB)
> scale, and running prep over more regions.
>
> **Implementation note.** The committed tool consolidates the design below into one
> `prep_region.py` that drives `ogr2ogr` (the S-57 read and the GeoPackage write) and the
> Python `sqlite3` stdlib (to complete any feature table an ingest did not create). It does
> NOT use the osgeo Python bindings, so the prep image only needs the GDAL CLI plus a plain
> `python3`. The image is pinned to the stable `ghcr.io/osgeo/gdal:ubuntu-small-3.10.3`: the
> rolling `latest` and the Alpine builds of the S-57 driver segfaulted on a valid NOAA cell,
> so the pin is load-bearing. The osgeo/gdal images are multi-architecture, so prep runs on
> amd64 and arm64. The task list below is retained as the design and test-intent record.

> **For agentic workers:** when the data is staged, execute task-by-task with
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn NOAA ENC `.000` cells, OSM water and land polygons, and admin-0 boundaries
into one per-region GeoPackage that exactly matches the Milestone 3A store schema, so the
runtime `LocalProvider` reads real geometry.

**Architecture:** A batch prep tool under `container/prep/`, GDAL-heavy and non-resident. It
runs as its own container image built on a GDAL base, invoked by the owner per region. GDAL
is allowed here and ONLY here. The output GeoPackage carries no GDAL dependency, so the
runtime image stays native-lib-free. The tool is Python: the S-57 attribute handling,
per-cell usage-band grouping, and overlapping-cell precedence are far easier to express in
Python with the `osgeo` bindings than in Rust linking system GDAL, and prep is non-resident
so a Python plus GDAL footprint is acceptable.

**Tech Stack:** Python 3, GDAL (the `osgeo.ogr`/`osgeo.gdal` bindings and `ogr2ogr`), a GDAL
base container image. SQLite/GeoPackage is written through GDAL's GPKG driver. No part of
this enters the runtime image.

## Global Constraints

- The output GeoPackage MUST match the Milestone 3A store schema exactly (the shared
  contract in `2026-06-27-companion-milestone-3-overview.md` and repeated in the 3A plan):
  tables `enc_depth_areas(fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL,
  drval1 REAL, drval2 REAL)`, `enc_land_areas(fid, geom, band)`, `osm_water(fid, geom)`,
  `boundaries(fid, geom, country_id TEXT NOT NULL)`, the standard gpkg metadata tables, and
  one R-tree per feature table named `rtree_<table>_geom(id, minx, maxx, miny, maxy)`.
- `band` is exactly one of the lowercase strings `overview general coastal approach harbour
  berthing`. The 3A reader matches these verbatim, so any drift breaks the read.
- Coordinates are WGS84 (EPSG:4326), stored as GeoPackage WKB, axis order longitude then
  latitude. NOAA ENC is already EPSG:4326, so no reprojection, but assert the SRS.
- `drval1` is DRVAL1 (shallow depth value, meters) and `drval2` is DRVAL2 (deep depth
  value, meters). The NEGATIVE drying convention is load-bearing: a drying height arrives as
  a negative DRVAL1 and MUST be preserved with its sign, never abs-ed or clamped. The 3A
  reader and the engine treat `drval1 < 0` as land.
- No GDAL, GEOS, PROJ, or SpatiaLite may appear in the RUNTIME image or in the published
  npm tarball. This tool and its image are separate artifacts, run by the owner, never
  shipped resident.
- Datasets and output stores live on the NVMe bind mount, never committed to git and never
  in an image layer.

## GDAL S-57 facts this plan relies on (confirmed against the GDAL S-57 driver docs)

- Options are set via the `OGR_S57_OPTIONS` environment variable or `-oo NAME=VALUE`. Use
  `RECODE_BY_DSSI=ON` (default, UTF-8 recode), and for soundings `SPLIT_MULTIPOINT=ON` with
  `ADD_SOUNDG_DEPTH=ON` (only needed if a later milestone ingests point soundings; not
  required for the 3A schema). `UPDATES=APPLY` (default) folds `.001+` update cells into the
  base on the fly.
- Each S-57 object class becomes an OGR layer named by its acronym: `DEPARE` (depth area),
  `DRGARE` (dredged area), `LNDARE` (land area), `M_COVR` (coverage), and `DSID` (a
  one-feature dataset-identification layer). Attributes use the S-57 acronyms: `DRVAL1`,
  `DRVAL2`, `CATCOV` (M_COVR coverage category: 1 = coverage available, 2 = no coverage).
- The chart usage band (1 to 6) is the navigational purpose. The robust source is the NOAA
  ENC cell file name: an ENC cell is named like `US5FL11M.000`, where the third character is
  the navigational-purpose digit (1 Overview, 2 General, 3 Coastal, 4 Approach, 5 Harbour, 6
  Berthing). Cross-check against the `DSID` layer's `DSID_INTU` (intended usage) field. Use
  the cell-name digit as the primary source, and log a warning if `DSID_INTU` disagrees.

## File Structure

- `container/prep/Dockerfile` — the prep image, on a GDAL base (for example `ghcr.io/osgeo/gdal:ubuntu-small-<ver>`), with Python and the tool. Responsibility: a runnable prep environment with GDAL.
- `container/prep/prep_region.py` — the entry point: arguments are a region name, a directory of ENC `.000` cells, an OSM extract path, an admin-0 path, and an output `.gpkg`. Responsibility: orchestrate the three ingests and write the store.
- `container/prep/enc.py` — S-57 ingestion: read DEPARE, DRGARE, and LNDARE per cell, group by usage band, apply precedence, write `enc_depth_areas` and `enc_land_areas`. Responsibility: the ENC half.
- `container/prep/osm.py` — OSM water ingestion into `osm_water`. Responsibility: water polygons.
- `container/prep/boundaries.py` — admin-0 ingestion into `boundaries`. Responsibility: country polygons.
- `container/prep/schema.py` — the GeoPackage schema creation and the R-tree setup, the single source of the DDL. Responsibility: a store that matches the 3A contract.
- `container/prep/validate.py` — the cell-versus-ArcGIS validation gate (Task 6). Responsibility: prove the prep output before building on it.
- `container/prep/README.md` — how the owner runs prep per region, and the ENC and OSM download steps.

---

## Task 1: The store schema writer

**Files:** Create `container/prep/schema.py`. Test: a pytest that creates an empty store and asserts the four feature tables, the gpkg metadata tables, and the four R-trees exist.

- [ ] **Step 1: Write the failing test.** Create the store via the function under test, open it with sqlite3, and assert `gpkg_contents` lists `boundaries`, `enc_depth_areas`, `enc_land_areas`, and `osm_water`, and that `rtree_enc_depth_areas_geom` and the other three R-trees exist in `sqlite_master`.
- [ ] **Step 2: Run it, confirm it fails** (function missing).
- [ ] **Step 3: Implement.** Use the GDAL GPKG driver to create the datasource and the four feature layers with the exact columns from the Global Constraints, geometry type POLYGON or MULTIPOLYGON, SRS EPSG:4326, and enable the GPKG R-tree (`SPATIAL_INDEX=YES` layer creation option, which creates `rtree_<table>_geom`). Confirm the R-tree column order is `(id, minx, maxx, miny, maxy)` (the GPKG standard), matching the 3A reader's overlap query.
- [ ] **Step 4: Run it, confirm pass.**
- [ ] **Step 5: Commit.** `feat(prep): create the region GeoPackage schema matching the 3A contract`

## Task 2: ENC usage-band resolution

**Files:** Create `container/prep/enc.py` with the band resolver. Test: a pytest over cell-name fixtures.

- [ ] **Step 1: Write the failing test.** `band_for_cell("US5FL11M.000")` returns `"harbour"`, `"US1...000"` returns `"overview"`, `"US6...000"` returns `"berthing"`, and a name with a non-digit third character raises a clear error.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement** the cell-name to band map: digit 1 to 6 maps to `overview general coastal approach harbour berthing` in order. Read the third character of the basename, validate it is 1 to 6, and return the band string. Provide a `BANDS_BY_DIGIT` dict so the mapping is the single source.
- [ ] **Step 4: Run it, confirm pass.**
- [ ] **Step 5: Commit.** `feat(prep): resolve the ENC usage band from the cell name`

## Task 3: DEPARE, DRGARE, and LNDARE ingestion with precedence

**Files:** Extend `container/prep/enc.py`. Test: a pytest against a SMALL hand-built S-57-like fixture, or, if building an S-57 fixture is impractical, against a real test cell once staged (mark the test `@pytest.mark.requires_cell` and skip when absent).

- [ ] **Step 1: Write the test.** Given a directory with one or more cells, ingest into a store and assert: each DEPARE and DRGARE polygon becomes an `enc_depth_areas` row with the cell's band, `drval1` set from DRVAL1 (sign preserved, including a negative drying value), and `drval2` from DRVAL2; each LNDARE polygon becomes an `enc_land_areas` row with the cell's band; and where two cells of different bands overlap, the finer band's geometry is present (precedence by band).
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** Open each cell with `OGR_S57_OPTIONS=RECODE_BY_DSSI=ON` and `UPDATES=APPLY`. For each cell, resolve its band (Task 2). Read the `DEPARE` and `DRGARE` layers, and for each feature write `enc_depth_areas(geom, band, drval1=DRVAL1, drval2=DRVAL2)`. Read `LNDARE` into `enc_land_areas(geom, band)`. Preserve the DRVAL1 sign exactly: do not abs, do not clamp, leave NULL when the attribute is absent. Process cells in coarse-to-fine band order so the finer band is written last; precedence is by band order, matching the engine's finest-first query. Use `M_COVR` with `CATCOV = 1` to confirm a cell's coverage extent and to avoid emitting open-water nodata as a depth area (the ArcGIS source gave coverage implicitly; here M_COVR is the explicit coverage mask). Set the geometry SRS to EPSG:4326 and assert it.
- [ ] **Step 4: Run it, confirm pass** (with the staged cell).
- [ ] **Step 5: Commit.** `feat(prep): ingest DEPARE, DRGARE, and LNDARE into the store`

## Task 4: OSM water ingestion

**Files:** Create `container/prep/osm.py`. Test: ingest a small clipped OSM water extract and assert `osm_water` rows with EPSG:4326 polygons within the region bbox.

- [ ] **Step 1: Write the test.**
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** Read the OSM water and land polygons from the osmdata.openstreetmap.de split product, clip to the region bounding box with GDAL, and write the water polygons into `osm_water`. Keep outer ring then island holes intact. Confirm the SRS is EPSG:4326.
- [ ] **Step 4: Run it, confirm pass.**
- [ ] **Step 5: Commit.** `feat(prep): ingest OSM water polygons into the store`

## Task 5: Admin-0 boundary ingestion

**Files:** Create `container/prep/boundaries.py`. Test: ingest an admin-0 source clipped to the region and assert `boundaries` rows each carry a non-empty `country_id`.

- [ ] **Step 1: Write the test.**
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** Read the admin-0 polygons, clip to the region, and write `boundaries(geom, country_id)`. The `country_id` is the admin-0 identifier the request's `homeCountryId` is compared against in 3A: pick a stable field (for example the ISO 3166-1 alpha-3 code) and document the choice, because 3A compares `country_id <> homeCountryId` directly. The Milestone 4 caller must pass the same identifier scheme.
- [ ] **Step 4: Run it, confirm pass.**
- [ ] **Step 5: Commit.** `feat(prep): ingest admin-0 boundaries into the store`

## Task 6: The cell-versus-ArcGIS validation gate

**Files:** Create `container/prep/validate.py` and `container/prep/prep_region.py` (the orchestrator). Test: an end-to-end run on one staged region, then the validation.

- [ ] **Step 1: Orchestrate.** `prep_region.py` calls schema, enc, osm, and boundaries in order to build one region store, then runs validate. Commit the orchestrator.
- [ ] **Step 2: Validate (spec section 11 gate).** For one region, sample points and compare the prep output against the online NOAA ArcGIS ENC Direct service for the same area. The load-bearing assertion is NOT pixel-identical geometry (shoreline generalizations differ): it is that the `inEncDeep` classification (a point is in a depth area with `shallow_meters >= contour`) and the drying-as-land classification (`shallow_meters < 0`) agree per sample between the local store and the online ENC, because those drive `usedTileWater` and the depth caveat. Report any divergence with the sample location and both values.
- [ ] **Step 3: Document** in `container/prep/README.md` the owner workflow: where to download ENC cells per region (the NOAA ENC download), where to get the OSM split extract and the admin-0 source, and the single `prep_region.py` command. State plainly that ENC and chart data are downloaded by the owner and never bundled.
- [ ] **Step 4: Commit.** `feat(prep): orchestrate a region build and validate against ArcGIS`

---

## Self-Review

**Spec coverage:** This plan implements the spec section 6 prep stage (S-57 via GDAL, OSM
water, admin-0 boundaries, one GeoPackage per region with R-tree indexes) and the section 11
cell-versus-ArcGIS validation gate. It targets the exact 3A schema contract, so the runtime
`LocalProvider` reads it unchanged.

**Schema consistency with 3A:** the table names, columns, `band` values, `drval1`/`drval2`
mapping, the negative drying sign, and the R-tree column order all match the 3A reader. A
change to any of them is a change to the shared contract and must update the 3A plan too.

**Honest data-gated note:** Tasks 1 and 2 are testable now (pure schema and string logic).
Tasks 3 through 6 need GDAL plus a real ENC cell, an OSM extract, and network access to the
ArcGIS service, so they are finalized and run when those inputs are staged. The exact GDAL
field selection for DEPARE and DRGARE attributes should be confirmed against the staged
cell's actual attribute set at execution, because S-57 producers vary; the schema target and
the normalization rules do not change.

## Open decisions resolved by judgement (revisit if the data contradicts them)

- Tooling is Python plus GDAL, not Rust plus system GDAL: prep is non-resident, and the S-57
  attribute and band logic is clearer in Python.
- The band source is the NOAA cell-name navigational-purpose digit, with `DSID_INTU` as a
  cross-check, because the cell name is the stable NOAA convention.
- `country_id` is the admin-0 ISO 3166-1 alpha-3 code; the Milestone 4 caller must use the
  same scheme for `homeCountryId`. Confirm against the chosen admin-0 source's fields.
- Point hazards (WRECKS, UWTROC, OBSTRN), soundings (SOUNDG), and the sounding-quality
  attribute QUASOU are NOT in the 3A routing schema, so they are out of scope here. The spec
  section 6 lists them, plus the RETURN_PRIMITIVES and SPLIT_MULTIPOINT options, for
  completeness across the whole geodata effort, but the routing classifications use only
  DRVAL1 and DRVAL2, so this prep stores only DEPARE, DRGARE, and LNDARE geometry plus those
  two depth values. The hazards and soundings belong to the separate leg-safety geometry
  migration, not the routing geodata store.
