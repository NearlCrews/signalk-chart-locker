//! The Rust mirror of the shared `ChartSource` and `UpstreamTemplate`, deserialized from the plugin
//! `POST /config` payload (camelCase JSON from the `signalk-chart-sources` package). The
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
    pub vector_maxzoom: Option<u32>,
    #[serde(default)]
    pub bounds: Option<[f64; 4]>,
    #[serde(default)]
    pub coverage: Option<Vec<[f64; 4]>>,
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
    Wms {
        base: String,
        layers: String,
        styles: String,
        version: String,
        format: String,
        transparent: bool,
    },
    #[serde(rename_all = "camelCase")]
    Arcgis { base: String },
    #[serde(rename_all = "camelCase")]
    Style {
        style_url: String,
        allowed_hosts: Vec<String>,
    },
}

impl ChartSource {
    /// Validate the trusted-catalog payload again at the container boundary so version skew or a
    /// malformed direct config push cannot install unsafe or nonsensical source definitions.
    pub fn is_valid(&self, allow_http: bool) -> bool {
        if !valid_source_id(&self.id)
            || self.title.trim().is_empty()
            || !matches!(self.tile_size, 256 | 512)
            || self.minzoom > self.maxzoom
            || self.maxzoom > 24
            || self
                .vector_maxzoom
                .is_some_and(|zoom| zoom < self.minzoom || zoom > self.maxzoom)
            || self.bounds.is_some_and(|bbox| !valid_source_bbox(bbox))
            || self.coverage.as_ref().is_some_and(|coverage| {
                coverage.is_empty() || coverage.iter().any(|bbox| !valid_source_bbox(*bbox))
            })
        {
            return false;
        }
        match &self.upstream {
            UpstreamTemplate::Xyz { url_template } | UpstreamTemplate::Wmts { url_template } => {
                valid_upstream_url(url_template, allow_http).is_some()
                    && ["{z}", "{x}", "{y}"]
                        .iter()
                        .all(|token| url_template.contains(token))
            }
            UpstreamTemplate::Wms {
                base,
                layers,
                version,
                format,
                ..
            } => {
                valid_upstream_url(base, allow_http).is_some()
                    && !layers.is_empty()
                    && !version.is_empty()
                    && !format.is_empty()
            }
            UpstreamTemplate::Arcgis { base } => valid_upstream_url(base, allow_http).is_some(),
            UpstreamTemplate::Style {
                style_url,
                allowed_hosts,
            } => {
                let Some(url) = valid_upstream_url(style_url, allow_http) else {
                    return false;
                };
                let Some(style_host) = url.host_str() else {
                    return false;
                };
                !allowed_hosts.is_empty()
                    && allowed_hosts.iter().all(|host| valid_host(host))
                    && allowed_hosts
                        .iter()
                        .any(|host| host.eq_ignore_ascii_case(style_host))
            }
        }
    }
}

fn valid_source_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 256
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().try_fold(false, |separator, byte| {
            if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
                Some(false)
            } else if matches!(byte, b'.' | b'_' | b'-') && !separator {
                Some(true)
            } else {
                None
            }
        }) == Some(false)
}

fn valid_upstream_url(value: &str, allow_http: bool) -> Option<reqwest::Url> {
    reqwest::Url::parse(value).ok().filter(|url| {
        (url.scheme() == "https" || (allow_http && url.scheme() == "http"))
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && !value.chars().any(char::is_whitespace)
        && !value.contains(['/', '@', '?', '#'])
}

fn valid_source_bbox([west, south, east, north]: [f64; 4]) -> bool {
    [west, south, east, north].iter().all(|v| v.is_finite())
        && (-180.0..=180.0).contains(&west)
        && (-180.0..=180.0).contains(&east)
        && (-90.0..=90.0).contains(&south)
        && (-90.0..=90.0).contains(&north)
        && west != east
        && !(west > east && (west - east).abs() == 360.0)
        && south < north
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
            UpstreamTemplate::Wms {
                ref base,
                ref layers,
                ..
            } => {
                assert_eq!(base, "https://w/wms");
                assert_eq!(layers, "GEBCO_LATEST");
            }
            _ => panic!("expected wms"),
        }
    }

    #[test]
    fn deserializes_vector_maxzoom_when_present_and_defaults_to_none() {
        let with: ChartSource = serde_json::from_str(
            r#"{"id":"basemap","title":"B","tileSize":256,"minzoom":0,"maxzoom":20,"vectorMaxzoom":14,"attribution":"",
                "upstream":{"mode":"style","styleUrl":"https://t/s","allowedHosts":["t"]}}"#,
        ).unwrap();
        assert_eq!(with.vector_maxzoom, Some(14));
        let without: ChartSource = serde_json::from_str(
            r#"{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"xyz","urlTemplate":"https://h/{z}/{x}/{y}.png"}}"#,
        )
        .unwrap();
        assert_eq!(without.vector_maxzoom, None);
    }

    #[test]
    fn deserializes_disjoint_coverage_when_present() {
        let source: ChartSource = serde_json::from_str(
            r#"{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "coverage":[[170,-10,180,10],[-180,-10,-170,10]],
                "upstream":{"mode":"xyz","urlTemplate":"https://h/{z}/{x}/{y}.png"}}"#,
        )
        .unwrap();
        assert_eq!(source.coverage.as_ref().map(Vec::len), Some(2));
        assert!(source.is_valid(false));
    }

    #[test]
    fn source_validation_rejects_unsafe_identity_urls_and_style_hosts() {
        let mut source: ChartSource = serde_json::from_str(
            r#"{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"xyz","urlTemplate":"http://example.test/{z}/{x}/{y}"}}"#,
        )
        .unwrap();
        assert!(!source.is_valid(false), "production requires HTTPS");
        assert!(source.is_valid(true), "development permits HTTP stubs");
        source.id = "../escape".into();
        assert!(!source.is_valid(true));

        let style: ChartSource = serde_json::from_str(
            r#"{"id":"style","title":"S","tileSize":512,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"style","styleUrl":"https://tiles.example.test/style.json","allowedHosts":["other.example.test"]}}"#,
        )
        .unwrap();
        assert!(!style.is_valid(false));
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
            UpstreamTemplate::Style {
                ref style_url,
                ref allowed_hosts,
            } => {
                assert_eq!(style_url, "https://t/styles/liberty");
                assert_eq!(allowed_hosts, &["t".to_string()]);
            }
            _ => panic!("expected style"),
        }
    }
}
