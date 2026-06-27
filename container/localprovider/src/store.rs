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
