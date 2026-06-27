//! LocalProvider: reads a per-region GeoPackage store and answers the engine's
//! Provider queries. Opens the store read-only with immutable=1 so a read-only
//! NVMe mount works without a WAL sidecar.

use std::path::Path;

use binnacle_engine::{
    AreaPolygon, Bbox, ChartedAreas, DepthRange, EncAreaPolygon, Provider, RingPolygon, Rings,
    ScaleBand, TileWater,
};
use rusqlite::{Connection, OpenFlags};

use crate::gpkg::{self, GeometryKind};

pub struct LocalProvider {
    conn: Connection,
    home_country_id: Option<String>,
}

/// Percent-encode characters that are meaningful in a SQLite URI query string.
/// Operator-set store paths are normally plain ASCII, so this is defensive.
fn encode_path_for_uri(path: &Path) -> String {
    path.to_string_lossy()
        .replace('%', "%25")
        .replace('?', "%3F")
        .replace('#', "%23")
        .replace(' ', "%20")
}

impl LocalProvider {
    /// Open a region store read-only. `immutable=1` lets a read-only mount work without
    /// a WAL sidecar. `home_country_id` selects which boundaries count as foreign;
    /// an empty string is treated the same as `None` (border awareness off).
    pub fn open(path: &Path, home_country_id: Option<String>) -> rusqlite::Result<Self> {
        let uri = format!("file:{}?immutable=1", encode_path_for_uri(path));
        let conn = Connection::open_with_flags(
            &uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        Ok(LocalProvider {
            conn,
            home_country_id: home_country_id.filter(|s| !s.is_empty()),
        })
    }

    /// Decode a GeoPackage blob into zero or more ring sets (one per WKB polygon).
    /// A valid Empty geometry returns `Ok(vec![])`. A malformed blob returns `Err` so
    /// the caller can propagate the failure rather than silently dropping the geometry.
    fn blob_to_polygons(blob: &[u8]) -> Result<Vec<Rings>, gpkg::GpkgError> {
        let geom = gpkg::decode(blob)?;
        if geom.kind == GeometryKind::Empty {
            return Ok(Vec::new());
        }
        Ok(geom.polygons.into_iter().map(|poly| poly.rings).collect())
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

    /// Return ring polygons for boundaries whose `country_id` differs from the home country.
    ///
    /// Border filtering is best-effort: a read or decode error on any row yields an empty
    /// result (fails open to not-blocked). The Milestone 4 border-aware caller must treat
    /// this return value as best-effort and validate its inputs accordingly.
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

/// Row type for `query_banded_polygons`: decoded polygon sets plus the two depth values.
type BandedRow = (Vec<Rings>, Option<f64>, Option<f64>);

fn query_banded_polygons(
    conn: &Connection,
    table: &str,
    band: ScaleBand,
    bbox: Bbox,
) -> rusqlite::Result<Vec<BandedRow>> {
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
            let rings = LocalProvider::blob_to_polygons(&blob).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Blob,
                    Box::new(e),
                )
            })?;
            Ok((rings, drval1, drval2))
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
            LocalProvider::blob_to_polygons(&blob).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Blob,
                    Box::new(e),
                )
            })
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
            LocalProvider::blob_to_polygons(&blob).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Blob,
                    Box::new(e),
                )
            })
        },
    )?;
    rows.collect()
}

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

    #[test]
    fn charted_areas_returns_none_on_a_corrupt_geometry_blob() {
        let square: &[[f64; 2]] = &[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [0.0, 0.0]];
        let file = StoreBuilder::new()
            .depth_area("coastal", Some(0.0), Some(5.0), &[square])
            .build();

        // Overwrite the geometry with a truncated blob: "GP" magic, version 0, LE flags, then one
        // byte before the srs_id field ends. The decoder returns GpkgError::TooShort, which must
        // surface as None rather than silently removing the obstacle.
        let corrupt: Vec<u8> = vec![0x47u8, 0x50, 0x00, 0x01, 0xff];
        {
            let rw = Connection::open(file.path()).unwrap();
            rw.execute(
                "UPDATE enc_depth_areas SET geom = ?1",
                rusqlite::params![corrupt],
            )
            .unwrap();
        }

        let p = LocalProvider::open(file.path(), None).unwrap();
        let bbox = Bbox { north: 1.0, south: 0.5, east: 1.0, west: 0.5 };
        assert!(p.charted_areas(ScaleBand::Coastal, bbox).is_none());
    }
}
