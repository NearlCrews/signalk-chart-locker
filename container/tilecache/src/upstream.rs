//! Build the upstream URL for a source at z/x/y, the Rust mirror of the package `expandUpstreamUrl`.
//! xyz and wmts substitute the tile coordinate; wms and arcgis compute the EPSG:3857 tile bbox with
//! the same ORIGIN constant and formula as the TS copy, so the two agree. z/x/y are validated first.

use crate::source::{ChartSource, UpstreamTemplate};

const ORIGIN: f64 = 20037508.342789244;

/// Mirror of the package `MAX_TILE_ZOOM`, kept as a named constant because the residue limit is
/// derived from it just like the package derives its own. The Node integration test in
/// test/chart-sources-integration.test.ts pins this value to the package's `MAX_TILE_ZOOM`, so a
/// package bump that moves it fails there instead of silently diverging.
const MAX_TILE_ZOOM_MIRROR: u32 = 30;

/// Mirror of the package `RESIDUE_LIMIT_METERS`: half the smallest real tile edge, the edge at
/// `MAX_TILE_ZOOM`, so `ORIGIN / 2^30`. A tile edge on the projection origin is mathematically
/// zero; a magnitude below this limit is floating-point residue of that zero. The TS copy must snap
/// it to `0` because `Number#toString` renders it in exponential notation, which the OGC BBOX
/// grammar rejects. Rust Display never uses exponential notation, but snapping here keeps the two
/// expansions byte-identical.
const RESIDUE_LIMIT_METERS: f64 = ORIGIN / (1u64 << MAX_TILE_ZOOM_MIRROR) as f64;

/// One BBOX ordinate as a Display value: sub-limit residue writes as the zero it represents,
/// everything else writes as the shortest round-trip decimal, matching the package `bboxNumber`.
/// A Display newtype rather than an owned String keeps a four-ordinate BBOX at one allocation.
struct BboxNumber(f64);

impl std::fmt::Display for BboxNumber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0.abs() < RESIDUE_LIMIT_METERS {
            f.write_str("0")
        } else {
            write!(f, "{}", self.0)
        }
    }
}

/// Drop trailing slashes from a base URL, matching the package `withoutTrailingSlashes`. ArcGIS
/// needs it because the export path is appended and a kept slash would double up; WMS gets the same
/// treatment so one base cannot produce two spellings of the same request and split the cache.
fn without_trailing_slashes(base: &str) -> &str {
    base.trim_end_matches('/')
}

/// EPSG:3857 bounds [minX, minY, maxX, maxY] of XYZ tile z/x/y. y increases downward.
pub fn web_mercator_tile_bounds(z: u32, x: u32, y: u32) -> [f64; 4] {
    let size = (2.0 * ORIGIN) / 2f64.powi(z as i32);
    let min_x = -ORIGIN + x as f64 * size;
    let max_x = min_x + size;
    let max_y = ORIGIN - y as f64 * size;
    let min_y = max_y - size;
    [min_x, min_y, max_x, max_y]
}

/// A rejected request: an out-of-range tile coordinate or a style source asked for as a tile.
#[derive(Debug, PartialEq, Eq)]
pub struct BadRequest(pub String);

fn in_range(source: &ChartSource, z: u32, x: u32, y: u32) -> Result<(), BadRequest> {
    if z < source.minzoom || z > source.maxzoom {
        return Err(BadRequest(format!("z {z} out of range for {}", source.id)));
    }
    // checked_shl guards a source whose maxzoom is absurd (>= 64): the shift would overflow, so an
    // unshiftable z yields span 0 and every x/y is rejected as out of range.
    let span = 1u64.checked_shl(z).unwrap_or(0);
    if u64::from(x) >= span || u64::from(y) >= span {
        return Err(BadRequest(format!("x/y {x}/{y} out of range at z {z}")));
    }
    Ok(())
}

fn bbox_str(z: u32, x: u32, y: u32) -> String {
    let b = web_mercator_tile_bounds(z, x, y);
    format!(
        "{},{},{},{}",
        BboxNumber(b[0]),
        BboxNumber(b[1]),
        BboxNumber(b[2]),
        BboxNumber(b[3])
    )
}

/// Expand the upstream URL for a non-style source at z/x/y. A style source returns its style URL
/// (its sub-resources are handled by the style route, not here).
pub fn expand_upstream(source: &ChartSource, z: u32, x: u32, y: u32) -> Result<String, BadRequest> {
    match &source.upstream {
        UpstreamTemplate::Xyz { url_template } | UpstreamTemplate::Wmts { url_template } => {
            in_range(source, z, x, y)?;
            Ok(url_template
                .replace("{z}", &z.to_string())
                .replace("{x}", &x.to_string())
                .replace("{y}", &y.to_string()))
        }
        UpstreamTemplate::Wms {
            base,
            layers,
            styles,
            version,
            format,
            transparent,
        } => {
            in_range(source, z, x, y)?;
            let base = without_trailing_slashes(base);
            Ok(format!(
                "{base}?SERVICE=WMS&VERSION={version}&REQUEST=GetMap&LAYERS={layers}&CRS=EPSG:3857&BBOX={}&WIDTH={ts}&HEIGHT={ts}&FORMAT={format}&TRANSPARENT={transparent}&STYLES={styles}",
                bbox_str(z, x, y),
                ts = source.tile_size,
            ))
        }
        UpstreamTemplate::Arcgis { base } => {
            in_range(source, z, x, y)?;
            let base = without_trailing_slashes(base);
            Ok(format!(
                "{base}/export?bbox={}&bboxSR=3857&imageSR=3857&size={ts},{ts}&dpi=96&format=png32&transparent=true&f=image",
                bbox_str(z, x, y),
                ts = source.tile_size,
            ))
        }
        UpstreamTemplate::Style { .. } => Err(BadRequest(format!(
            "{} is a style source, not a tile source",
            source.id
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xyz() -> ChartSource {
        serde_json::from_str(
            r#"{"id":"x","title":"X","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"xyz","urlTemplate":"https://h/{z}/{x}/{y}.png"}}"#,
        )
        .unwrap()
    }
    fn wms() -> ChartSource {
        serde_json::from_str(
            r#"{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"wms","base":"https://w/wms","layers":"0,1","styles":"q","version":"1.3.0","format":"image/png","transparent":true}}"#,
        )
        .unwrap()
    }

    #[test]
    fn z0_bounds_are_the_full_extent() {
        assert_eq!(
            web_mercator_tile_bounds(0, 0, 0),
            [-ORIGIN, -ORIGIN, ORIGIN, ORIGIN]
        );
    }

    #[test]
    fn xyz_substitutes_the_tile_coordinate() {
        assert_eq!(
            expand_upstream(&xyz(), 3, 2, 1).unwrap(),
            "https://h/3/2/1.png"
        );
    }

    #[test]
    fn wms_builds_a_getmap_with_the_3857_bbox() {
        let url = expand_upstream(&wms(), 0, 0, 0).unwrap();
        assert!(url.contains("REQUEST=GetMap"));
        assert!(url.contains("CRS=EPSG:3857"));
        assert!(url.contains("LAYERS=0,1"));
        assert!(url.contains("WIDTH=256"));
        assert!(url.contains(&format!("BBOX={}", bbox_str(0, 0, 0))));
    }

    #[test]
    fn out_of_range_is_rejected() {
        assert!(expand_upstream(&xyz(), 1, 2, 0).is_err()); // x 2 >= 2^1
        assert!(expand_upstream(&wms(), 30, 0, 0).is_err()); // z above maxzoom
    }

    #[test]
    fn arcgis_normalizes_a_trailing_slash() {
        let source: ChartSource = serde_json::from_str(
            r#"{"id":"a","title":"A","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"arcgis","base":"https://h/MapServer/"}}"#,
        )
        .unwrap();
        let url = expand_upstream(&source, 0, 0, 0).unwrap();
        assert!(url.starts_with("https://h/MapServer/export?"));
    }

    #[test]
    fn wms_normalizes_trailing_slashes() {
        let source: ChartSource = serde_json::from_str(
            r#"{"id":"w","title":"W","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"wms","base":"https://w/wms//","layers":"0","styles":"","version":"1.3.0","format":"image/png","transparent":true}}"#,
        )
        .unwrap();
        let url = expand_upstream(&source, 0, 0, 0).unwrap();
        assert!(url.starts_with("https://w/wms?SERVICE=WMS"), "{url}");
    }

    #[test]
    fn bbox_residue_snaps_to_zero() {
        assert_eq!(BboxNumber(0.0).to_string(), "0");
        assert_eq!(BboxNumber(-0.0).to_string(), "0");
        // 1e-7 is where Number#toString switches to exponential notation; the snap keeps the two
        // mirrors writing the same "0".
        assert_eq!(BboxNumber(1e-7).to_string(), "0");
        assert_eq!(BboxNumber(-1e-7).to_string(), "0");
        // The limit itself is a genuine tile edge and stays decimal (strict <, as in the package).
        assert_eq!(
            BboxNumber(RESIDUE_LIMIT_METERS).to_string(),
            RESIDUE_LIMIT_METERS.to_string()
        );
        assert_eq!(BboxNumber(-ORIGIN).to_string(), "-20037508.342789244");
    }

    #[test]
    fn wms_bbox_writes_zero_edges_in_plain_decimal() {
        // Tile (18, 2^17, 2^17) has two edges on the projection origin.
        let url = expand_upstream(&wms(), 18, 131_072, 131_072).unwrap();
        let bbox = url
            .split("BBOX=")
            .nth(1)
            .and_then(|rest| rest.split('&').next())
            .unwrap();
        assert!(!bbox.contains(['e', 'E']), "{bbox}");
        assert!(bbox.starts_with("0,"), "{bbox}");
        assert!(bbox.ends_with(",0"), "{bbox}");
    }
}
