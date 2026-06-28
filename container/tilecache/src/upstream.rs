//! Build the upstream URL for a source at z/x/y, the Rust mirror of the package `expandUpstreamUrl`.
//! xyz and wmts substitute the tile coordinate; wms and arcgis compute the EPSG:3857 tile bbox with
//! the same ORIGIN constant and formula as the TS copy, so the two agree. z/x/y are validated first.

use crate::source::{ChartSource, UpstreamTemplate};

const ORIGIN: f64 = 20037508.342789244;

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
    format!("{},{},{},{}", b[0], b[1], b[2], b[3])
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
        UpstreamTemplate::Wms { base, layers, styles, version, format, transparent } => {
            in_range(source, z, x, y)?;
            Ok(format!(
                "{base}?SERVICE=WMS&VERSION={version}&REQUEST=GetMap&LAYERS={layers}&CRS=EPSG:3857&BBOX={}&WIDTH={ts}&HEIGHT={ts}&FORMAT={format}&TRANSPARENT={transparent}&STYLES={styles}",
                bbox_str(z, x, y),
                ts = source.tile_size,
            ))
        }
        UpstreamTemplate::Arcgis { base } => {
            in_range(source, z, x, y)?;
            Ok(format!(
                "{base}/export?bbox={}&bboxSR=3857&imageSR=3857&size={ts},{ts}&dpi=96&format=png32&transparent=true&f=image",
                bbox_str(z, x, y),
                ts = source.tile_size,
            ))
        }
        UpstreamTemplate::Style { .. } => Err(BadRequest(format!("{} is a style source, not a tile source", source.id))),
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
        assert_eq!(web_mercator_tile_bounds(0, 0, 0), [-ORIGIN, -ORIGIN, ORIGIN, ORIGIN]);
    }

    #[test]
    fn xyz_substitutes_the_tile_coordinate() {
        assert_eq!(expand_upstream(&xyz(), 3, 2, 1).unwrap(), "https://h/3/2/1.png");
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
}
