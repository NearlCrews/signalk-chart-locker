# Milestone 3A: Runtime LocalProvider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Rust `LocalProvider` that reads a per-region GeoPackage store with `rusqlite` and a pure-Rust WKB decoder, implements the engine's `Provider` trait, and lets the router route over real geometry instead of declining `no-coverage`.

**Architecture:** A new standalone crate `binnacle-localprovider` depends on `binnacle-engine` for the `Provider` trait and its types, and on `rusqlite` (bundled SQLite, R-tree) for the store. It lifts the WKB/GeoPackage decoder proven in the Milestone 1.5 storage spike. The router constructs a `LocalProvider` per request from a configured region-store path, falling back to `EmptyProvider` (honest `no-coverage`) when no store is configured or the open fails. Tests run against synthetic GeoPackage fixtures built in-process, so no GDAL, NOAA ENC, or OSM data is needed to develop and verify this milestone.

**Tech Stack:** Rust 2021, `rusqlite` 0.31 with `bundled`, `binnacle-engine` (path dep), axum 0.7 (router, already present). No GDAL, GEOS, PROJ, or SpatiaLite.

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`; every task implicitly includes these.

- The runtime image carries no GDAL, GEOS, PROJ, or SpatiaLite. GeoPackage reads use `rusqlite` with the `bundled` feature plus a pure-Rust WKB decoder.
- The engine stays pure geometry. `LocalProvider` lives in its own crate, never inside `container/engine`.
- Region stores are opened read-only with `immutable=1` (not WAL, which a read-only mount cannot support).
- Units are SI internally (meters, radians, Kelvin). Coordinates are WGS84/EPSG:4326, stored WKB axis order X then Y, which is `[longitude, latitude]`, matching the engine's `Ring = Vec<[f64; 2]>`.
- `DRVAL1` (`shallow_meters`), `DRVAL2` (`deep_meters`), and the negative drying sign are load-bearing values, not metadata.
- The container computes geometry only and must never make a route read as safer than the data supports. A successful-but-empty store reads as `no-coverage`; only a real query or decode error reads as `fetch-failed`.
- `cargo clippy --all-targets -- -D warnings` must be clean. Numerics: `LocalProvider` does I/O and decode only, no parity-sensitive float math, so it needs no `.cargo/config.toml` of its own; the engine's FMA rule still governs the engine code.
- The store schema is the shared contract defined in `2026-06-27-companion-milestone-3-overview.md`. Do not diverge from it.
- The synthetic fixture builder lives behind a `testutil` cargo feature so the router's integration test reuses it without copy-paste, and so neither the fixture nor `tempfile` enters the release binary. Run this crate's own tests and clippy with the feature: `cargo test --features testutil` and `cargo clippy --all-targets --features testutil -- -D warnings`. The plain release build (`cargo build --release`) leaves the feature off, so the fixture is never compiled into the shipped binary.

The shared schema, repeated for the implementer (you may be reading this task out of order):

- `enc_depth_areas(fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL, drval1 REAL, drval2 REAL)`
- `enc_land_areas(fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL)`
- `osm_water(fid INTEGER PRIMARY KEY, geom BLOB NOT NULL)`
- `boundaries(fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, country_id TEXT NOT NULL)`
- Standard `gpkg_spatial_ref_sys`, `gpkg_contents`, `gpkg_geometry_columns`, and one R-tree per feature table named `rtree_<table>_geom(id, minx, maxx, miny, maxy)`.
- `band` is one of `overview general coastal approach harbour berthing` (the lowercase `ScaleBand` serde values).
- Overlap test (feature bbox vs query `Bbox { north, south, east, west }`): `minx <= east AND maxx >= west AND miny <= north AND maxy >= south`.

Engine types this milestone produces (verbatim from `container/engine/src/types.rs`):

```rust
pub type Ring = Vec<[f64; 2]>;          // [lon, lat] vertices
pub type Rings = Vec<Ring>;             // outer ring then holes
pub struct Bbox { pub north: f64, pub south: f64, pub east: f64, pub west: f64 }
pub struct DepthRange { pub shallow_meters: Option<f64>, pub deep_meters: Option<f64> }
pub struct EncAreaPolygon { pub rings: Rings, pub depth_range: Option<DepthRange> }
pub struct ChartedAreas { pub depth_areas: Vec<EncAreaPolygon>, pub land_areas: Vec<EncAreaPolygon> }
pub struct AreaPolygon { pub rings: Rings }
pub struct TileWater { pub water: Vec<AreaPolygon> }
pub struct RingPolygon { pub rings: Rings }
pub enum ScaleBand { Overview, General, Coastal, Approach, Harbour, Berthing } // serde lowercase
pub trait Provider {
    fn charted_areas(&self, band: ScaleBand, bbox: Bbox) -> Option<ChartedAreas>;
    fn tile_water(&self, bbox: Bbox) -> Option<TileWater>;
    fn foreign_rings(&self, bbox: Bbox) -> Vec<RingPolygon>;
}
```

---

## File Structure

- `container/localprovider/Cargo.toml` — new crate manifest. Responsibility: declare deps (`binnacle-engine`, `rusqlite` bundled).
- `container/localprovider/src/lib.rs` — crate root. Responsibility: re-export `LocalProvider`, wire the modules.
- `container/localprovider/src/gpkg.rs` — pure-Rust GeoPackage-blob and WKB decoder, lifted from the storage spike. Responsibility: blob bytes to geometry.
- `container/localprovider/src/store.rs` — `LocalProvider`: open the store, run the R-tree queries, decode, and build the engine types. Responsibility: the `Provider` impl.
- `container/localprovider/src/fixture.rs` — `#[cfg(test)]` only. Responsibility: build a synthetic GeoPackage in a temp file for tests (schema DDL plus a minimal GeoPackage-Polygon blob encoder). Not compiled into release builds.
- `container/router/Cargo.toml` — modified: add the `binnacle-localprovider` path dep.
- `container/router/src/lib.rs` — modified: select `LocalProvider` when a region store is configured, else `EmptyProvider`.
- `container/router/src/main.rs` — modified: read the region-store path from the environment.
- `container/engine/src/types.rs` — modified: add `home_country_id: Option<String>` to `ChannelRouteRequest` (serde default, camelCase), so the request can carry the home country for border-aware routing.
- `container/Dockerfile` — modified: copy the `localprovider` crate into the build context.

---

## Task 1: New crate with the lifted WKB decoder

**Files:**
- Create: `container/localprovider/Cargo.toml`
- Create: `container/localprovider/src/lib.rs`
- Create: `container/localprovider/src/gpkg.rs` (copy of `container/storage-spike/src/gpkg.rs`)

**Interfaces:**
- Consumes: nothing (leaf crate, plus `binnacle-engine` declared for later tasks).
- Produces: `binnacle_localprovider::gpkg::{decode, Geometry, GeometryKind, Polygon, Point}` where `decode(blob: &[u8]) -> Result<Geometry, GpkgError>`, `Polygon { rings: Vec<Vec<[f64; 2]>> }`, `Geometry { srs_id: i32, kind: GeometryKind, polygons: Vec<Polygon> }`, `Point = [f64; 2]`.

- [ ] **Step 1: Create the crate manifest**

`container/localprovider/Cargo.toml`:

```toml
[package]
name = "binnacle-localprovider"
version = "0.1.0"
edition = "2021"

[lib]
name = "binnacle_localprovider"
path = "src/lib.rs"

[dependencies]
binnacle-engine = { path = "../engine" }
rusqlite = { version = "0.31", features = ["bundled"] }
tempfile = { version = "3", optional = true }

[features]
# The synthetic GeoPackage fixture builder is behind this feature so the router's
# integration test can reuse it as a dev-dependency, and so neither the fixture code nor
# tempfile is ever compiled into the release binary. Run this crate's tests with the feature.
testutil = ["dep:tempfile"]
```

- [ ] **Step 2: Lift the decoder**

Copy `container/storage-spike/src/gpkg.rs` verbatim to `container/localprovider/src/gpkg.rs`. It is a standalone pure-Rust module with no storage-spike-specific dependencies. Leave the storage spike untouched as the historical proof.

`container/localprovider/src/lib.rs`:

```rust
//! Reads a per-region GeoPackage store and implements the engine's Provider trait.
//! No GDAL, GEOS, PROJ, or SpatiaLite: rusqlite with bundled SQLite plus a pure-Rust
//! WKB decoder, exactly the read path proven in the Milestone 1.5 storage spike.

pub mod gpkg;
pub mod store;
#[cfg(feature = "testutil")]
pub mod fixture;

pub use store::LocalProvider;
```

(`store` and `fixture` are created in later tasks; if the crate must compile after Task 1 alone, comment the `pub mod store;` and `pub use` lines and restore them in Task 3. The subagent driving this plan should add them when their task lands. `fixture` is gated by the `testutil` feature so it compiles for this crate's own feature-enabled tests and for the router's dev-dependency, but never for the release binary.)

- [ ] **Step 3: Write the decoder round-trip test**

Confirm the lifted decoder reads a standard little-endian GeoPackage Polygon blob and yields `[lon, lat]` vertices in WKB X-then-Y order. Add to `container/localprovider/src/gpkg.rs` under its existing `#[cfg(test)] mod tests` (or create one):

```rust
#[cfg(test)]
mod lift_tests {
    use super::*;

    // GeoPackage blob: "GP", version 0, flags 0x01 (LE, no envelope), srs_id 4326,
    // then WKB Polygon with one ring of a unit square at lon 10..11, lat 50..51.
    fn unit_square_blob() -> Vec<u8> {
        let mut b = vec![0x47, 0x50, 0x00, 0x01]; // magic, version, flags
        b.extend_from_slice(&4326i32.to_le_bytes()); // srs_id
        b.push(0x01); // WKB byte order: little endian
        b.extend_from_slice(&3u32.to_le_bytes()); // WKB type: Polygon
        b.extend_from_slice(&1u32.to_le_bytes()); // ring count
        b.extend_from_slice(&5u32.to_le_bytes()); // point count (closed ring)
        for (lon, lat) in [(10.0, 50.0), (11.0, 50.0), (11.0, 51.0), (10.0, 51.0), (10.0, 50.0)] {
            b.extend_from_slice(&(lon as f64).to_le_bytes());
            b.extend_from_slice(&(lat as f64).to_le_bytes());
        }
        b
    }

    #[test]
    fn decodes_lon_lat_polygon() {
        let g = decode(&unit_square_blob()).unwrap();
        assert_eq!(g.srs_id, 4326);
        assert_eq!(g.kind, GeometryKind::Polygon);
        assert_eq!(g.polygons.len(), 1);
        let ring = &g.polygons[0].rings[0];
        assert_eq!(ring[0], [10.0, 50.0]); // [lon, lat], not [lat, lon]
        assert_eq!(ring[2], [11.0, 51.0]);
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cd container/localprovider && cargo test --lib gpkg`
Expected: PASS. If the decoder's public names differ from `decode`/`Geometry`/`GeometryKind`/`Polygon`, adjust the `use` and assertions to the actual names read from the lifted file (do not rename the decoder).

- [ ] **Step 5: Commit**

```bash
git add container/localprovider/Cargo.toml container/localprovider/src/lib.rs container/localprovider/src/gpkg.rs
git commit -m "feat: add the localprovider crate with the lifted GeoPackage decoder"
```

---

## Task 2: Synthetic GeoPackage fixture builder (test-only)

**Files:**
- Create: `container/localprovider/src/fixture.rs`
- Test: same file (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `gpkg::Point` shape (`[f64; 2]`), `rusqlite::Connection`.
- Produces (test-only): `fixture::StoreBuilder` with
  `new() -> StoreBuilder`,
  `depth_area(band: &str, drval1: Option<f64>, drval2: Option<f64>, rings: &[&[[f64; 2]]]) -> &mut Self`,
  `land_area(band: &str, rings: &[&[[f64; 2]]]) -> &mut Self`,
  `water(rings: &[&[[f64; 2]]]) -> &mut Self`,
  `boundary(country_id: &str, rings: &[&[[f64; 2]]]) -> &mut Self`,
  `build() -> tempfile::NamedTempFile` (returns a temp `.gpkg`, keep it alive for the test's duration), and a free function
  `encode_polygon_blob(rings: &[&[[f64; 2]]]) -> Vec<u8>`.

- [ ] **Step 1: Write the failing test**

`container/localprovider/src/fixture.rs`:

```rust
//! Synthetic GeoPackage builder behind the `testutil` feature. Produces a store matching
//! the Milestone 3 schema so LocalProvider, and the router integration test, can be tested
//! without GDAL, NOAA ENC, or OSM data. Never compiled into the release binary.

use rusqlite::{params, Connection};

#[test]
fn builds_a_store_with_the_four_feature_tables() {
    let f = StoreBuilder::new()
        .water(&[&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]]])
        .build();
    let conn = Connection::open(f.path()).unwrap();
    let mut stmt = conn
        .prepare("SELECT table_name FROM gpkg_contents ORDER BY table_name")
        .unwrap();
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(names, ["boundaries", "enc_depth_areas", "enc_land_areas", "osm_water"]);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd container/localprovider && cargo test --features testutil --lib fixture`
Expected: FAIL to compile, `StoreBuilder` not found.

- [ ] **Step 3: Implement the fixture builder and the blob encoder**

Append to `container/localprovider/src/fixture.rs`:

```rust
/// Encode a GeoPackage geometry blob: little-endian, no envelope, srs_id 4326, WKB Polygon.
/// `rings` is the outer ring followed by hole rings, each `[lon, lat]` and explicitly closed.
pub fn encode_polygon_blob(rings: &[&[[f64; 2]]]) -> Vec<u8> {
    let mut b = vec![0x47u8, 0x50, 0x00, 0x01]; // "GP", version 0, flags 0x01 (LE, no envelope)
    b.extend_from_slice(&4326i32.to_le_bytes());
    b.push(0x01); // WKB byte order: little endian
    b.extend_from_slice(&3u32.to_le_bytes()); // WKB type: Polygon
    b.extend_from_slice(&(rings.len() as u32).to_le_bytes());
    for ring in rings {
        b.extend_from_slice(&(ring.len() as u32).to_le_bytes());
        for pt in ring.iter() {
            b.extend_from_slice(&pt[0].to_le_bytes()); // lon (X)
            b.extend_from_slice(&pt[1].to_le_bytes()); // lat (Y)
        }
    }
    b
}

fn ring_bounds(rings: &[&[[f64; 2]]]) -> (f64, f64, f64, f64) {
    let mut minx = f64::INFINITY;
    let mut maxx = f64::NEG_INFINITY;
    let mut miny = f64::INFINITY;
    let mut maxy = f64::NEG_INFINITY;
    for ring in rings {
        for pt in ring.iter() {
            minx = minx.min(pt[0]);
            maxx = maxx.max(pt[0]);
            miny = miny.min(pt[1]);
            maxy = maxy.max(pt[1]);
        }
    }
    (minx, maxx, miny, maxy)
}

struct Feature {
    table: &'static str,
    band: Option<String>,
    drval1: Option<f64>,
    drval2: Option<f64>,
    country_id: Option<String>,
    blob: Vec<u8>,
    bounds: (f64, f64, f64, f64),
}

pub struct StoreBuilder {
    features: Vec<Feature>,
}

impl StoreBuilder {
    pub fn new() -> Self {
        StoreBuilder { features: Vec::new() }
    }

    fn push(
        &mut self,
        table: &'static str,
        band: Option<&str>,
        drval1: Option<f64>,
        drval2: Option<f64>,
        country_id: Option<&str>,
        rings: &[&[[f64; 2]]],
    ) -> &mut Self {
        self.features.push(Feature {
            table,
            band: band.map(str::to_string),
            drval1,
            drval2,
            country_id: country_id.map(str::to_string),
            blob: encode_polygon_blob(rings),
            bounds: ring_bounds(rings),
        });
        self
    }

    pub fn depth_area(&mut self, band: &str, drval1: Option<f64>, drval2: Option<f64>, rings: &[&[[f64; 2]]]) -> &mut Self {
        self.push("enc_depth_areas", Some(band), drval1, drval2, None, rings)
    }
    pub fn land_area(&mut self, band: &str, rings: &[&[[f64; 2]]]) -> &mut Self {
        self.push("enc_land_areas", Some(band), None, None, None, rings)
    }
    pub fn water(&mut self, rings: &[&[[f64; 2]]]) -> &mut Self {
        self.push("osm_water", None, None, None, None, rings)
    }
    pub fn boundary(&mut self, country_id: &str, rings: &[&[[f64; 2]]]) -> &mut Self {
        self.push("boundaries", None, None, None, Some(country_id), rings)
    }

    pub fn build(&mut self) -> tempfile::NamedTempFile {
        let file = tempfile::Builder::new().suffix(".gpkg").tempfile().unwrap();
        let conn = Connection::open(file.path()).unwrap();
        conn.execute_batch(SCHEMA_DDL).unwrap();
        let mut next_fid = 1i64;
        for f in &self.features {
            let fid = next_fid;
            next_fid += 1;
            match f.table {
                "enc_depth_areas" => conn.execute(
                    "INSERT INTO enc_depth_areas (fid, geom, band, drval1, drval2) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![fid, f.blob, f.band, f.drval1, f.drval2],
                ),
                "enc_land_areas" => conn.execute(
                    "INSERT INTO enc_land_areas (fid, geom, band) VALUES (?1, ?2, ?3)",
                    params![fid, f.blob, f.band],
                ),
                "osm_water" => conn.execute(
                    "INSERT INTO osm_water (fid, geom) VALUES (?1, ?2)",
                    params![fid, f.blob],
                ),
                "boundaries" => conn.execute(
                    "INSERT INTO boundaries (fid, geom, country_id) VALUES (?1, ?2, ?3)",
                    params![fid, f.blob, f.country_id],
                ),
                other => panic!("unknown fixture table {other}"),
            }
            .unwrap();
            let (minx, maxx, miny, maxy) = f.bounds;
            conn.execute(
                &format!(
                    "INSERT INTO rtree_{}_geom (id, minx, maxx, miny, maxy) VALUES (?1, ?2, ?3, ?4, ?5)",
                    f.table
                ),
                params![fid, minx, maxx, miny, maxy],
            )
            .unwrap();
        }
        file
    }
}

const SCHEMA_DDL: &str = "
CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id INTEGER, definition TEXT, description TEXT);
INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84 geographic', 4326, 'EPSG', 4326, 'GEOGCS', NULL);
CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, description TEXT, last_change TEXT, min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER);
CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);

CREATE TABLE enc_depth_areas (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL, drval1 REAL, drval2 REAL);
CREATE TABLE enc_land_areas  (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, band TEXT NOT NULL);
CREATE TABLE osm_water       (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL);
CREATE TABLE boundaries      (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, country_id TEXT NOT NULL);

CREATE VIRTUAL TABLE rtree_enc_depth_areas_geom USING rtree(id, minx, maxx, miny, maxy);
CREATE VIRTUAL TABLE rtree_enc_land_areas_geom  USING rtree(id, minx, maxx, miny, maxy);
CREATE VIRTUAL TABLE rtree_osm_water_geom       USING rtree(id, minx, maxx, miny, maxy);
CREATE VIRTUAL TABLE rtree_boundaries_geom      USING rtree(id, minx, maxx, miny, maxy);

INSERT INTO gpkg_contents (table_name, data_type, srs_id) VALUES
  ('enc_depth_areas', 'features', 4326),
  ('enc_land_areas',  'features', 4326),
  ('osm_water',       'features', 4326),
  ('boundaries',      'features', 4326);
INSERT INTO gpkg_geometry_columns VALUES
  ('enc_depth_areas', 'geom', 'POLYGON', 4326, 0, 0),
  ('enc_land_areas',  'geom', 'POLYGON', 4326, 0, 0),
  ('osm_water',       'geom', 'POLYGON', 4326, 0, 0),
  ('boundaries',      'geom', 'POLYGON', 4326, 0, 0);
";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd container/localprovider && cargo test --features testutil --lib fixture`
Expected: PASS. Also run `cargo test --lib gpkg` to confirm `encode_polygon_blob` round-trips through `decode` if you add such an assertion.

- [ ] **Step 5: Commit**

```bash
git add container/localprovider/src/fixture.rs container/localprovider/src/lib.rs
git commit -m "test: add a synthetic GeoPackage fixture builder for localprovider"
```

---

## Task 3: LocalProvider::open and charted_areas

**Files:**
- Create: `container/localprovider/src/store.rs`
- Test: same file (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `gpkg::{decode, GeometryKind}`, `fixture::StoreBuilder` (tests), engine types listed in Global Constraints.
- Produces: `LocalProvider` with `open(path: &std::path::Path, home_country_id: Option<String>) -> rusqlite::Result<LocalProvider>`, and `impl binnacle_engine::Provider for LocalProvider`. Internal helper `fn polygons_to_rings(geom: gpkg::Geometry) -> Vec<Rings>`.

- [ ] **Step 1: Write the failing test**

`container/localprovider/src/store.rs`:

```rust
//! LocalProvider: reads a per-region GeoPackage store and answers the engine's
//! Provider queries. Opens the store read-only with immutable=1 so a read-only
//! NVMe mount works without a WAL sidecar.

use std::path::Path;

use binnacle_engine::{
    AreaPolygon, Bbox, ChartedAreas, DepthRange, EncAreaPolygon, Provider, RingPolygon, Rings,
    ScaleBand, TileWater,
};
use rusqlite::{params, Connection, OpenFlags};

use crate::gpkg::{self, GeometryKind};

// Gated on the testutil feature too, because these tests use the feature-gated fixture builder.
#[cfg(all(test, feature = "testutil"))]
mod tests {
    use super::*;
    use crate::fixture::StoreBuilder;

    fn band_str(b: ScaleBand) -> &'static str {
        match b {
            ScaleBand::Overview => "overview",
            ScaleBand::General => "general",
            ScaleBand::Coastal => "coastal",
            ScaleBand::Approach => "approach",
            ScaleBand::Harbour => "harbour",
            ScaleBand::Berthing => "berthing",
        }
    }

    #[test]
    fn charted_areas_returns_depth_and_land_for_the_band_in_bbox() {
        let square: &[[f64; 2]] = &[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [0.0, 0.0]];
        let file = StoreBuilder::new()
            .depth_area("coastal", Some(-1.0), Some(5.0), &[square]) // drying area, drval1 negative
            .land_area("coastal", &[square])
            .depth_area("harbour", Some(3.0), Some(9.0), &[square]) // different band
            .build();
        let p = LocalProvider::open(file.path(), None).unwrap();
        let bbox = Bbox { north: 1.0, south: 0.5, east: 1.0, west: 0.5 };

        let coastal = p.charted_areas(ScaleBand::Coastal, bbox).unwrap();
        assert_eq!(coastal.depth_areas.len(), 1);
        assert_eq!(coastal.depth_areas[0].depth_range, Some(DepthRange { shallow_meters: Some(-1.0), deep_meters: Some(5.0) }));
        assert_eq!(coastal.land_areas.len(), 1);
        assert!(coastal.land_areas[0].depth_range.is_none());

        // A band with no rows in bbox still returns Some (present-but-empty), not None.
        let berthing = p.charted_areas(ScaleBand::Berthing, bbox).unwrap();
        assert!(berthing.depth_areas.is_empty() && berthing.land_areas.is_empty());

        // The other band's row is excluded.
        let _ = band_str(ScaleBand::Harbour);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd container/localprovider && cargo test --features testutil --lib store`
Expected: FAIL to compile, `LocalProvider` not found.

- [ ] **Step 3: Implement open, the query helpers, and charted_areas**

Add to `container/localprovider/src/store.rs` (above the test module):

```rust
pub struct LocalProvider {
    conn: Connection,
    home_country_id: Option<String>,
}

impl LocalProvider {
    /// Open a region store read-only. `immutable=1` lets a read-only mount work without
    /// a WAL sidecar. `home_country_id` selects which boundaries count as foreign.
    pub fn open(path: &Path, home_country_id: Option<String>) -> rusqlite::Result<Self> {
        let uri = format!("file:{}?immutable=1", path.display());
        let conn = Connection::open_with_flags(
            &uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        Ok(LocalProvider { conn, home_country_id })
    }

    /// Decode a GeoPackage blob into zero or more rings sets (one per WKB polygon).
    fn blob_to_polygons(blob: &[u8]) -> Vec<Rings> {
        match gpkg::decode(blob) {
            Ok(geom) if geom.kind != GeometryKind::Empty => {
                geom.polygons.into_iter().map(|poly| poly.rings).collect()
            }
            _ => Vec::new(),
        }
    }
}

fn band_value(band: ScaleBand) -> &'static str {
    match band {
        ScaleBand::Overview => "overview",
        ScaleBand::General => "general",
        ScaleBand::Coastal => "coastal",
        ScaleBand::Approach => "approach",
        ScaleBand::Harbour => "harbour",
        ScaleBand::Berthing => "berthing",
    }
}

impl Provider for LocalProvider {
    fn charted_areas(&self, band: ScaleBand, bbox: Bbox) -> Option<ChartedAreas> {
        let depth = query_banded_polygons(&self.conn, "enc_depth_areas", band, bbox);
        let land = query_banded_polygons(&self.conn, "enc_land_areas", band, bbox);
        match (depth, land) {
            (Ok(depth_rows), Ok(land_rows)) => Some(ChartedAreas {
                depth_areas: depth_rows
                    .into_iter()
                    .flat_map(|(rings_sets, drval1, drval2)| {
                        rings_sets.into_iter().map(move |rings| EncAreaPolygon {
                            rings,
                            depth_range: Some(DepthRange { shallow_meters: drval1, deep_meters: drval2 }),
                        })
                    })
                    .collect(),
                land_areas: land_rows
                    .into_iter()
                    .flat_map(|(rings_sets, _, _)| {
                        rings_sets.into_iter().map(|rings| EncAreaPolygon { rings, depth_range: None })
                    })
                    .collect(),
            }),
            // A query or decode error is a genuine fetch failure: return None so the
            // engine declines fetch-failed rather than no-coverage.
            _ => None,
        }
    }

    fn tile_water(&self, bbox: Bbox) -> Option<TileWater> {
        match query_plain_polygons(&self.conn, "osm_water", bbox) {
            Ok(rows) => Some(TileWater {
                water: rows.into_iter().flatten().map(|rings| AreaPolygon { rings }).collect(),
            }),
            Err(_) => None,
        }
    }

    fn foreign_rings(&self, bbox: Bbox) -> Vec<RingPolygon> {
        let Some(home) = self.home_country_id.as_deref() else {
            return Vec::new();
        };
        match query_foreign_polygons(&self.conn, bbox, home) {
            Ok(rows) => rows.into_iter().flatten().map(|rings| RingPolygon { rings }).collect(),
            Err(_) => Vec::new(),
        }
    }
}

// The R-tree overlap predicate: a feature whose bbox overlaps the query window.
// Bbox is { north, south, east, west }; feature bbox is (minx, maxx, miny, maxy).
const OVERLAP: &str =
    "r.minx <= :east AND r.maxx >= :west AND r.miny <= :north AND r.maxy >= :south";

fn query_banded_polygons(
    conn: &Connection,
    table: &str,
    band: ScaleBand,
    bbox: Bbox,
) -> rusqlite::Result<Vec<(Vec<Rings>, Option<f64>, Option<f64>)>> {
    // enc_land_areas has no drval columns; select NULLs so the row shape is uniform.
    let drval = if table == "enc_depth_areas" { "t.drval1, t.drval2" } else { "NULL, NULL" };
    let sql = format!(
        "SELECT t.geom, {drval} FROM {table} t \
         JOIN rtree_{table}_geom r ON t.fid = r.id \
         WHERE t.band = :band AND {OVERLAP}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::named_params! {
            ":band": band_value(band),
            ":east": bbox.east, ":west": bbox.west, ":north": bbox.north, ":south": bbox.south,
        },
        |row| {
            let blob: Vec<u8> = row.get(0)?;
            let drval1: Option<f64> = row.get(1)?;
            let drval2: Option<f64> = row.get(2)?;
            Ok((LocalProvider::blob_to_polygons(&blob), drval1, drval2))
        },
    )?;
    rows.collect()
}

fn query_plain_polygons(conn: &Connection, table: &str, bbox: Bbox) -> rusqlite::Result<Vec<Vec<Rings>>> {
    let sql = format!(
        "SELECT t.geom FROM {table} t JOIN rtree_{table}_geom r ON t.fid = r.id WHERE {OVERLAP}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::named_params! {
            ":east": bbox.east, ":west": bbox.west, ":north": bbox.north, ":south": bbox.south,
        },
        |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(LocalProvider::blob_to_polygons(&blob))
        },
    )?;
    rows.collect()
}

fn query_foreign_polygons(conn: &Connection, bbox: Bbox, home: &str) -> rusqlite::Result<Vec<Vec<Rings>>> {
    let sql = format!(
        "SELECT t.geom FROM boundaries t JOIN rtree_boundaries_geom r ON t.fid = r.id \
         WHERE t.country_id <> :home AND {OVERLAP}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::named_params! {
            ":home": home,
            ":east": bbox.east, ":west": bbox.west, ":north": bbox.north, ":south": bbox.south,
        },
        |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(LocalProvider::blob_to_polygons(&blob))
        },
    )?;
    rows.collect()
}
```

Restore `pub mod store;` and `pub use store::LocalProvider;` in `lib.rs` if Task 1 commented them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd container/localprovider && cargo test --features testutil --lib store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/localprovider/src/store.rs container/localprovider/src/lib.rs
git commit -m "feat: LocalProvider opens a region store and answers charted_areas"
```

---

## Task 4: tile_water query

**Files:**
- Modify: `container/localprovider/src/store.rs` (the impl is already written in Task 3; this task adds the test that locks the behavior)

**Interfaces:**
- Consumes: Task 3's `LocalProvider` and `query_plain_polygons`.
- Produces: no new public surface; verifies `tile_water`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `container/localprovider/src/store.rs`:

```rust
#[test]
fn tile_water_returns_osm_water_in_bbox_and_empty_some_outside() {
    let square: &[[f64; 2]] = &[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [0.0, 0.0]];
    let file = StoreBuilder::new().water(&[square]).build();
    let p = LocalProvider::open(file.path(), None).unwrap();

    let inside = p.tile_water(Bbox { north: 1.0, south: 0.5, east: 1.0, west: 0.5 }).unwrap();
    assert_eq!(inside.water.len(), 1);
    assert_eq!(inside.water[0].rings[0][0], [0.0, 0.0]);

    let outside = p.tile_water(Bbox { north: 9.0, south: 8.0, east: 9.0, west: 8.0 }).unwrap();
    assert!(outside.water.is_empty()); // present-but-empty, still Some
}
```

- [ ] **Step 2: Run it**

Run: `cd container/localprovider && cargo test --features testutil --lib tile_water`
Expected: PASS (the impl exists from Task 3). If it fails, fix `tile_water`/`query_plain_polygons`, not the test.

- [ ] **Step 3: Commit**

```bash
git add container/localprovider/src/store.rs
git commit -m "test: lock tile_water to osm_water bbox queries"
```

---

## Task 5: foreign_rings query

**Files:**
- Modify: `container/localprovider/src/store.rs` (impl from Task 3; this task adds the test)

**Interfaces:**
- Consumes: Task 3's `LocalProvider` and `query_foreign_polygons`.
- Produces: verifies `foreign_rings` honors `home_country_id`.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `container/localprovider/src/store.rs`:

```rust
#[test]
fn foreign_rings_excludes_the_home_country_and_is_empty_without_one() {
    let us: &[[f64; 2]] = &[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]];
    let mx: &[[f64; 2]] = &[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]];
    let file = StoreBuilder::new()
        .boundary("US", &[us])
        .boundary("MX", &[mx])
        .build();
    let bbox = Bbox { north: 1.0, south: 0.0, east: 1.0, west: 0.0 };

    let home_us = LocalProvider::open(file.path(), Some("US".to_string())).unwrap();
    let foreign = home_us.foreign_rings(bbox);
    assert_eq!(foreign.len(), 1); // only MX is foreign

    let no_home = LocalProvider::open(file.path(), None).unwrap();
    assert!(no_home.foreign_rings(bbox).is_empty()); // border-aware off
}
```

- [ ] **Step 2: Run it**

Run: `cd container/localprovider && cargo test --features testutil --lib foreign_rings`
Expected: PASS (impl from Task 3). Then run the whole crate and clippy:
`cargo test --features testutil && cargo clippy --all-targets --features testutil -- -D warnings`. Both green.

- [ ] **Step 3: Commit**

```bash
git add container/localprovider/src/store.rs
git commit -m "test: lock foreign_rings to the home-country filter"
```

---

## Task 6: Wire LocalProvider into the router with an EmptyProvider fallback

**Files:**
- Modify: `container/engine/src/types.rs` (add `home_country_id` to `ChannelRouteRequest`)
- Modify: `container/router/Cargo.toml` (add the localprovider dep)
- Modify: `container/router/src/lib.rs` (provider selection in the handler)
- Modify: `container/router/src/main.rs` (read the store path from the environment)
- Modify: `container/Dockerfile` (copy the localprovider crate into the build)
- Test: `container/router/tests/http_test.rs` (integration: a real route over a fixture store)

**Interfaces:**
- Consumes: `binnacle_localprovider::LocalProvider`, the engine `route_channel`, `EmptyProvider` (already in the router).
- Produces: the router routes over a configured region store, and declines `no-coverage` when none is configured.

- [ ] **Step 1: Add `home_country_id` to the request type**

In `container/engine/src/types.rs`, add a field to `ChannelRouteRequest` (locate the struct; it derives Serialize/Deserialize with camelCase):

```rust
    /// The home country for border-aware routing. Absent means no border filter.
    #[serde(default)]
    pub home_country_id: Option<String>,
```

The `#[serde(default)]` keeps the parity corpus deserializing: corpus `request.json` files that omit the field decode to `None`, so the engine corpus and its 2-ULP bar are unaffected.

Adding the field breaks any in-tree `ChannelRouteRequest` struct literal that does not set it. There is one: the router unit test `route_on_water_declines_no_coverage_without_geodata` in `container/router/src/lib.rs`. Add `home_country_id: None,` to that literal in this step so the router crate keeps compiling. Grep `ChannelRouteRequest {` across `container/` to catch any other literal before moving on.

- [ ] **Step 2: Run the engine tests to confirm the corpus still loads**

Run: `cd container/engine && cargo test`
Expected: PASS, including the parity corpus, with `home_country_id` defaulting to `None`.

- [ ] **Step 3: Add the dep and write the failing integration test**

`container/router/Cargo.toml`, add to `[dependencies]`:

```toml
binnacle-localprovider = { path = "../localprovider" }
```

and to `[dev-dependencies]` (the `testutil` feature exposes the shared fixture builder, so the test reuses it instead of copying the schema and the blob encoder):

```toml
binnacle-localprovider = { path = "../localprovider", features = ["testutil"] }
serde_json = "1"
```

Listing the crate in both `[dependencies]` and `[dev-dependencies]` is fine: cargo unifies the features only for test builds, so `cargo build --release` still leaves `testutil` off and never compiles the fixture into the binary.

Write the failing integration test in `container/router/tests/http_test.rs`. It builds a fixture store with the shared `StoreBuilder`, hands the path to the router through state, and expects a real `ok: true` route:

```rust
// container/router/tests/http_test.rs (new test)
use axum::body::Body;
use axum::http::{Request, StatusCode};
use binnacle_localprovider::fixture::StoreBuilder;
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn route_on_water_returns_a_route_over_a_configured_store() {
    // A wide deep-water square (drval1 well above the request contour of 2.5 m) plus matching
    // tile water, covering lon -1..3, lat -1..3, so the from/to legs are navigable.
    let big: &[[f64; 2]] = &[[-1.0, -1.0], [3.0, -1.0], [3.0, 3.0], [-1.0, 3.0], [-1.0, -1.0]];
    let store = StoreBuilder::new()
        .depth_area("coastal", Some(20.0), Some(50.0), &[big])
        .water(&[big])
        .build();

    let app = binnacle_router::app_with_store(Some(store.path().to_path_buf()));
    let body = serde_json::json!({
        "from": { "latitude": 0.5, "longitude": 0.5 },
        "to": { "latitude": 0.5, "longitude": 1.5 },
        "draftMeters": 2.0,
        "safetyMarginMeters": 0.5,
        "standoffNm": 0.01,
        "borderAware": false
    })
    .to_string();
    let resp = app
        .oneshot(
            Request::post("/route-on-water")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["ok"], true, "expected a route, got {v}");
    assert!(v["waypoints"].as_array().unwrap().len() >= 2);
}
```

`app_with_store` is added in Step 5. Keep `store` (the `NamedTempFile`) bound for the whole test so the file is not deleted before the request runs.

- [ ] **Step 4: Run it to verify it fails**

Run: `cd container/router && cargo test --test http_test route_on_water_returns_a_route`
Expected: FAIL: the handler still uses `EmptyProvider`, so `ok` is `false` with `reason` `no-coverage`.

- [ ] **Step 5: Implement provider selection with router state**

Pass the store path through axum state, not a process-wide env var, so the tests never race on a global. In `container/router/src/lib.rs`, add the state type and a store-aware constructor, keeping the existing `app()` delegating so the health and regions tests stay unchanged:

```rust
use std::path::PathBuf;
use std::sync::Arc;
use axum::extract::State;

#[derive(Clone)]
struct RouterState {
    store_path: Arc<Option<PathBuf>>,
}

/// The HTTP surface with no region store: every route declines no-coverage. Used by tests
/// that do not exercise routing.
pub fn app() -> Router {
    app_with_store(None)
}

/// The HTTP surface bound to an optional region store.
pub fn app_with_store(store_path: Option<PathBuf>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/regions", get(regions))
        .route("/route-on-water", post(route_on_water))
        .with_state(RouterState { store_path: Arc::new(store_path) })
}
```

The `health` and `regions` handlers acquire the state type but do not extract it; leave their bodies unchanged. Change `route_on_water` to take the state and select the provider:

```rust
async fn route_on_water(
    State(state): State<RouterState>,
    Json(req): Json<ChannelRouteRequest>,
) -> Json<WireRouteResult> {
    let result = match state.store_path.as_ref() {
        Some(path) => match binnacle_localprovider::LocalProvider::open(path, req.home_country_id.clone()) {
            Ok(provider) => route_channel(&provider, &ScaleBand::ALL, &req),
            // A configured store that will not open is a genuine failure, not absent coverage.
            // UnavailableProvider returns None for both reads, which the engine declines fetch-failed.
            Err(_) => route_channel(&UnavailableProvider, &ScaleBand::ALL, &req),
        },
        // No store configured (the pre-store default): the engine declines no-coverage.
        None => route_channel(&EmptyProvider, &ScaleBand::ALL, &req),
    };
    Json(WireRouteResult::from(result))
}
```

Add `UnavailableProvider` next to `EmptyProvider` (the existing import line already brings in `Bbox`, `ChartedAreas`, `Provider`, `RingPolygon`, `ScaleBand`, and `TileWater`):

```rust
/// A provider that reports every read as failed. A configured-but-unopenable store routes over
/// this so the engine declines fetch-failed, the honest signal that the data source broke.
struct UnavailableProvider;

impl Provider for UnavailableProvider {
    fn charted_areas(&self, _band: ScaleBand, _bbox: Bbox) -> Option<ChartedAreas> { None }
    fn tile_water(&self, _bbox: Bbox) -> Option<TileWater> { None }
    fn foreign_rings(&self, _bbox: Bbox) -> Vec<RingPolygon> { Vec::new() }
}
```

In `container/router/src/main.rs`, read the store path from the environment once at startup and build the router with it (this replaces the bare `app()` call in the serve line):

```rust
let store_path = std::env::var("BINNACLE_REGION_STORE").ok().map(std::path::PathBuf::from);
axum::serve(listener, app_with_store(store_path))
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("serve router");
```

Opening an `immutable=1` SQLite connection per request over a read-only store is inexpensive. Note for a later optimization task: cache the opened connection or use a connection pool keyed by path if profiling shows the per-request open cost matters.

- [ ] **Step 6: Run the integration test and the unit tests**

Run: `cd container/router && cargo test`
Expected: PASS, including the new route test (which builds its own store and passes it through `app_with_store`) and the existing `route_on_water_declines_no_coverage` (which uses `app()` with no store). The store path travels through state, not a process-wide global, so the tests do not race.

- [ ] **Step 7: Update the Dockerfile build context**

In `container/Dockerfile`, the builder must now copy the `localprovider` crate so the router's path dep resolves. After the engine COPY lines, add:

```dockerfile
COPY localprovider/Cargo.toml localprovider/Cargo.toml
COPY localprovider/src localprovider/src
```

Confirm the relative path from `container/router` to `../localprovider` is present in the build context. Do not change base images, EXPOSE, HEALTHCHECK, or ENTRYPOINT.

- [ ] **Step 8: Full verification**

Run, all green:
```bash
cd container/engine && cargo test && cargo clippy --all-targets -- -D warnings
cd ../localprovider && cargo test && cargo clippy --all-targets -- -D warnings
cd ../router && cargo test && cargo clippy --all-targets -- -D warnings && cargo build --release --bin router
```
Then build and smoke-test the image once (slow on the Pi, allow a long timeout):
```bash
podman build --format docker -t binnacle-router:verify container
```

- [ ] **Step 9: Commit**

```bash
git add container/engine/src/types.rs container/router/Cargo.toml container/router/src/lib.rs container/router/src/main.rs container/router/tests/http_test.rs container/Dockerfile
git commit -m "feat: route over a configured region store via LocalProvider, fall back to no-coverage"
```

- [ ] **Step 10: Update docs**

Add a CHANGELOG `[Unreleased]` entry under Added: the `LocalProvider` region-store read path and the router wiring (no-coverage fallback when no store is configured). Update `CLAUDE.md` "Layout and status" to add `container/localprovider/` as the Milestone 3A runtime read path. Commit:

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: record the LocalProvider region-store read path"
```

---

## Self-Review

**Spec coverage:** This plan implements the runtime half of spec section 5 (the `LocalProvider` arm of the provider abstraction) and the runtime stage of section 6 (rusqlite plus pure-Rust WKB decoder, `immutable=1`, no runtime GDAL). The prep pipeline (section 6 prep stage), the cell-versus-ArcGIS validation (section 11), and the data-parity harness (section 8) are the deferred 3B and 3C plans, by design, per the overview document. The `usedTileWater` computation (lines 188-191) is the engine's, fed by this provider's `charted_areas`/`tile_water`; this plan supplies the data, the engine computes the flag.

**Placeholder scan:** No TBDs. Every code step has concrete code. The store path travels through router state (`app_with_store`), not a process-wide env var, so the integration test and the no-store test never race. The fixture builder is shared through the `testutil` feature rather than copied into the router test.

**Type consistency:** `LocalProvider::open(path, home_country_id)` is used identically in the store tests and the router handler. `band_value`/`band_str` map `ScaleBand` to the same lowercase strings the schema's `band` column holds. `encode_polygon_blob` and the decoder agree on little-endian, no-envelope, srs_id 4326, WKB Polygon. The R-tree predicate `OVERLAP` and the fixture's R-tree row insertion use the same `(minx, maxx, miny, maxy)` convention. `Rings = Vec<Vec<[f64; 2]>>` flows unchanged from `gpkg::Polygon.rings` into `EncAreaPolygon`/`AreaPolygon`/`RingPolygon`.

**Open contract note for 3B:** the schema's `band` values and the `drval1`/`drval2` to `shallow_meters`/`deep_meters` mapping defined here are the exact target the 3B prep pipeline must emit. 3B's S-57 normalization writes these columns; any change to them is a change to this shared contract and must update both plans.
