//! LocalProvider: reads a per-region GeoPackage store and answers the engine's
//! Provider queries. Opens the store read-only with immutable=1 so a read-only
//! NVMe mount works without a WAL sidecar.

use std::path::Path;

use binnacle_engine::{
    AreaPolygon, Bbox, ChartedAreas, DepthRange, EncAreaPolygon, Provider, RingPolygon, Rings,
    ScaleBand, TileWater,
};
use rusqlite::{Connection, OpenFlags};

use binnacle_gpkg::{self as gpkg, GeometryKind};

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
        let depth = query_depth_polygons(&self.conn, band, bbox);
        let land = query_land_polygons(&self.conn, band, bbox);
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
                    .flatten()
                    .map(|rings| EncAreaPolygon { rings, depth_range: None })
                    .collect(),
            }),
            // A query or decode error is a genuine fetch failure: log it and return None so the
            // engine declines fetch-failed rather than no-coverage, never silently dropping an
            // obstacle.
            (depth, land) => {
                if let Err(e) = depth {
                    eprintln!("localprovider: charted_areas depth query failed for {band:?}: {e}");
                }
                if let Err(e) = land {
                    eprintln!("localprovider: charted_areas land query failed for {band:?}: {e}");
                }
                None
            }
        }
    }

    fn tile_water(&self, bbox: Bbox) -> Option<TileWater> {
        match query_plain_polygons(&self.conn, "osm_water", bbox) {
            Ok(rows) => Some(TileWater {
                water: rows.into_iter().flatten().map(|rings| AreaPolygon { rings }).collect(),
            }),
            Err(e) => {
                eprintln!("localprovider: tile_water query failed: {e}");
                None
            }
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

// The R-tree overlap predicate: a feature whose bbox overlaps the query window. Bbox is
// { north, south, east, west }; the feature bbox is (minx, maxx, miny, maxy). A query bbox that
// crosses the antimeridian (west > east) would select nothing here, but the engine rejects such a
// bbox upstream in resolve_grid_size before any provider query, so this predicate never sees one.
const OVERLAP: &str =
    "r.minx <= :east AND r.maxx >= :west AND r.miny <= :north AND r.maxy >= :south";

/// Decode a geometry blob column into ring sets, mapping a decode failure to a rusqlite error so
/// the whole query fails loud (the band reads as fetch-failed) rather than dropping the obstacle.
fn decode_geom(blob: Vec<u8>) -> rusqlite::Result<Vec<Rings>> {
    LocalProvider::blob_to_polygons(&blob).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Blob, Box::new(e))
    })
}

/// A decoded depth-area row: ring sets plus DRVAL1 (shallow) and DRVAL2 (deep).
type DepthRow = (Vec<Rings>, Option<f64>, Option<f64>);

/// Depth-area rows for one band in the bbox: ring sets plus DRVAL1 and DRVAL2.
fn query_depth_polygons(conn: &Connection, band: ScaleBand, bbox: Bbox) -> rusqlite::Result<Vec<DepthRow>> {
    let sql = format!(
        "SELECT t.geom, t.drval1, t.drval2 FROM enc_depth_areas t \
         JOIN rtree_enc_depth_areas_geom r ON t.fid = r.id \
         WHERE t.band = :band AND {OVERLAP}"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(
        rusqlite::named_params! {
            ":band": band_value(band),
            ":east": bbox.east, ":west": bbox.west, ":north": bbox.north, ":south": bbox.south,
        },
        |row| {
            let drval1: Option<f64> = row.get(1)?;
            let drval2: Option<f64> = row.get(2)?;
            Ok((decode_geom(row.get(0)?)?, drval1, drval2))
        },
    )?;
    rows.collect()
}

/// Land-area ring sets for one band in the bbox (land carries no depth values).
fn query_land_polygons(conn: &Connection, band: ScaleBand, bbox: Bbox) -> rusqlite::Result<Vec<Vec<Rings>>> {
    let sql = format!(
        "SELECT t.geom FROM enc_land_areas t \
         JOIN rtree_enc_land_areas_geom r ON t.fid = r.id \
         WHERE t.band = :band AND {OVERLAP}"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(
        rusqlite::named_params! {
            ":band": band_value(band),
            ":east": bbox.east, ":west": bbox.west, ":north": bbox.north, ":south": bbox.south,
        },
        |row| decode_geom(row.get(0)?),
    )?;
    rows.collect()
}

fn query_plain_polygons(conn: &Connection, table: &str, bbox: Bbox) -> rusqlite::Result<Vec<Vec<Rings>>> {
    let sql = format!(
        "SELECT t.geom FROM {table} t JOIN rtree_{table}_geom r ON t.fid = r.id WHERE {OVERLAP}"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(
        rusqlite::named_params! {
            ":east": bbox.east, ":west": bbox.west, ":north": bbox.north, ":south": bbox.south,
        },
        |row| decode_geom(row.get(0)?),
    )?;
    rows.collect()
}

fn query_foreign_polygons(conn: &Connection, bbox: Bbox, home: &str) -> rusqlite::Result<Vec<Vec<Rings>>> {
    let sql = format!(
        "SELECT t.geom FROM boundaries t JOIN rtree_boundaries_geom r ON t.fid = r.id \
         WHERE t.country_id <> :home AND {OVERLAP}"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(
        rusqlite::named_params! {
            ":home": home,
            ":east": bbox.east, ":west": bbox.west, ":north": bbox.north, ":south": bbox.south,
        },
        |row| decode_geom(row.get(0)?),
    )?;
    rows.collect()
}

// Gated on the testutil feature too, because these tests use the feature-gated fixture builder.
#[cfg(all(test, feature = "testutil"))]
mod tests {
    use super::*;
    use crate::fixture::StoreBuilder;
    use binnacle_engine::{route_channel, ChannelRouteRequest, ChannelRouteResult, Position};

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

        // A band with no rows in bbox still returns Some (present-but-empty), not None, and the
        // harbour band's row is excluded from the coastal query.
        let berthing = p.charted_areas(ScaleBand::Berthing, bbox).unwrap();
        assert!(berthing.depth_areas.is_empty() && berthing.land_areas.is_empty());
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

    #[test]
    fn charted_areas_returns_none_on_a_non_polygon_land_geometry() {
        // S-57 LNDARE can carry point and line features, which PROMOTE_TO_MULTI writes as
        // MultiPoint or MultiLineString. The polygon-only reader must fail the band loud (None),
        // never silently drop the obstacle. The prep stage keeps the store polygon-only so a real
        // store never hits this, but the reader stays strict as the backstop. Regression for the
        // bug where non-area LNDARE made charted_areas return None and the router decline
        // no-coverage for a real cell.
        let square: &[[f64; 2]] = &[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [0.0, 0.0]];
        let file = StoreBuilder::new()
            .depth_area("harbour", Some(5.0), Some(9.0), &[square])
            .land_area("harbour", &[square])
            .build();

        // A valid GeoPackage blob carrying a WKB MultiPoint (type 4), the geometry class the
        // polygon-only reader rejects. LE, no envelope, srs 4326, one point at (1, 1).
        let mut mp = vec![0x47u8, 0x50, 0x00, 0x01];
        mp.extend_from_slice(&4326i32.to_le_bytes());
        mp.push(0x01); // WKB byte order: little endian
        mp.extend_from_slice(&4u32.to_le_bytes()); // WKB type: MultiPoint
        mp.extend_from_slice(&1u32.to_le_bytes()); // one point
        mp.push(0x01); // sub-point byte order
        mp.extend_from_slice(&1u32.to_le_bytes()); // WKB type: Point
        mp.extend_from_slice(&1.0f64.to_le_bytes()); // x (lon)
        mp.extend_from_slice(&1.0f64.to_le_bytes()); // y (lat)
        {
            // Replace the land geometry blob only; its R-tree bounds still overlap the bbox, so
            // the query selects the row and reaches the decode that must fail the band.
            let rw = Connection::open(file.path()).unwrap();
            rw.execute("UPDATE enc_land_areas SET geom = ?1", rusqlite::params![mp]).unwrap();
        }

        let p = LocalProvider::open(file.path(), None).unwrap();
        let bbox = Bbox { north: 1.5, south: 0.5, east: 1.5, west: 0.5 };
        assert!(p.charted_areas(ScaleBand::Harbour, bbox).is_none());
    }

    #[test]
    fn border_aware_blocks_foreign_water_and_falls_back() {
        // A foreign boundary that covers the navigable water (as a maritime EEZ does, unlike an
        // admin-0 land polygon, which covers only land) makes the engine block the foreign water
        // and take the border fallback. With the home country matching the boundary, nothing is
        // foreign and the route stays in home water with no fallback. This locks the border-aware
        // data contract: the boundaries source must cover water (Marine Regions EEZ, country_id
        // iso_sov1), not admin-0 land, or border-aware is a silent no-op.
        let sq: &[[f64; 2]] = &[[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1]];
        let file = StoreBuilder::new()
            .depth_area("coastal", Some(10.0), Some(20.0), &[sq]) // deep, navigable everywhere
            .boundary("FRA", &[sq]) // a foreign maritime zone over the water
            .build();
        let req = ChannelRouteRequest {
            from: Position { latitude: 0.0, longitude: 0.0 },
            to: Position { latitude: 0.03, longitude: 0.03 },
            draft_meters: 2.0,
            safety_margin_meters: 0.5,
            standoff_nm: 0.0,
            corridor: None,
            bbox_anchors: None,
            border_aware: true,
            max_snap_meters: None,
            deadline_ms: None,
            home_country_id: None,
        };

        // Home is FRA: the boundary is home water, nothing is foreign, the route needs no fallback.
        let home = LocalProvider::open(file.path(), Some("FRA".into())).unwrap();
        match route_channel(&home, &ScaleBand::ALL, &req) {
            ChannelRouteResult::Ok { border_fallback, .. } => assert!(!border_fallback, "home water: no fallback"),
            other => panic!("home route should succeed, got {other:?}"),
        }

        // Home is USA: the FRA boundary is foreign and covers the water, so the in-country attempt
        // finds no home water and the engine falls back across it, flagged for the caller.
        let foreign = LocalProvider::open(file.path(), Some("USA".into())).unwrap();
        match route_channel(&foreign, &ScaleBand::ALL, &req) {
            ChannelRouteResult::Ok { border_fallback, .. } => assert!(border_fallback, "foreign water: border fallback"),
            other => panic!("foreign route should still succeed via fallback, got {other:?}"),
        }
    }
}
