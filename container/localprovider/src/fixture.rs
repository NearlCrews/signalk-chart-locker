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

impl Default for StoreBuilder {
    fn default() -> Self {
        Self::new()
    }
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
        for (fid, f) in (1i64..).zip(self.features.iter()) {
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
