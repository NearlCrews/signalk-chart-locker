//! The Rust mirror of the shared `ChartSource` and `UpstreamTemplate`, deserialized from the plugin
//! `POST /config` payload (camelCase JSON from the `signalk-binnacle-chart-sources` package). The
//! container holds only this; it never reads Signal K.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSource {
    pub id: String,
    pub title: String,
    pub upstream: UpstreamTemplate,
    pub tile_size: u32,
    pub minzoom: u32,
    pub maxzoom: u32,
    #[serde(default)]
    pub bounds: Option<[f64; 4]>,
    pub attribution: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum UpstreamTemplate {
    #[serde(rename_all = "camelCase")]
    Xyz { url_template: String },
    #[serde(rename_all = "camelCase")]
    Wmts { url_template: String },
    #[serde(rename_all = "camelCase")]
    Wms { base: String, layers: String, styles: String, version: String, format: String, transparent: bool },
    #[serde(rename_all = "camelCase")]
    Arcgis { base: String },
    #[serde(rename_all = "camelCase")]
    Style { style_url: String, allowed_hosts: Vec<String> },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_the_camelcase_package_json() {
        let json = r#"{
            "id": "depth-gebco", "title": "GEBCO", "tileSize": 256, "minzoom": 0, "maxzoom": 12,
            "attribution": "GEBCO",
            "upstream": { "mode": "wms", "base": "https://w/wms", "layers": "GEBCO_LATEST", "styles": "", "version": "1.3.0", "format": "image/png", "transparent": true }
        }"#;
        let s: ChartSource = serde_json::from_str(json).unwrap();
        assert_eq!(s.id, "depth-gebco");
        assert_eq!(s.tile_size, 256);
        match s.upstream {
            UpstreamTemplate::Wms { ref base, ref layers, .. } => {
                assert_eq!(base, "https://w/wms");
                assert_eq!(layers, "GEBCO_LATEST");
            }
            _ => panic!("expected wms"),
        }
    }

    #[test]
    fn deserializes_an_xyz_and_a_style_source() {
        let xyz: ChartSource = serde_json::from_str(
            r#"{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"xyz","urlTemplate":"https://h/{z}/{x}/{y}.png"}}"#,
        )
        .unwrap();
        assert!(matches!(xyz.upstream, UpstreamTemplate::Xyz { .. }));
        let style: ChartSource = serde_json::from_str(
            r#"{"id":"basemap","title":"B","tileSize":256,"minzoom":0,"maxzoom":20,"attribution":"",
                "upstream":{"mode":"style","styleUrl":"https://t/styles/liberty","allowedHosts":["t"]}}"#,
        )
        .unwrap();
        match style.upstream {
            UpstreamTemplate::Style { ref style_url, ref allowed_hosts } => {
                assert_eq!(style_url, "https://t/styles/liberty");
                assert_eq!(allowed_hosts, &["t".to_string()]);
            }
            _ => panic!("expected style"),
        }
    }
}
