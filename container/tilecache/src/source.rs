//! The Rust mirror of the shared `ChartSource` and `UpstreamTemplate`, deserialized from the plugin
//! `POST /config` payload (camelCase JSON from the `signalk-chart-sources` package). The
//! container holds only this; it never reads Signal K.

use serde::Deserialize;

const MAX_TITLE_BYTES: usize = 256;
const MAX_ATTRIBUTION_BYTES: usize = 16 * 1024;
const MAX_URL_BYTES: usize = 4 * 1024;
const MAX_COVERAGE_BOXES: usize = 64;
const MAX_WMS_LAYER_BYTES: usize = 1024;
const MAX_WMS_STYLE_BYTES: usize = 1024;
const MAX_WMS_FORMAT_BYTES: usize = 128;
const MAX_ALLOWED_HOSTS: usize = 32;
const MAX_HOST_BYTES: usize = 253;

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
            || !valid_bounded_text(&self.title, MAX_TITLE_BYTES, false)
            || !valid_bounded_text(&self.attribution, MAX_ATTRIBUTION_BYTES, true)
            || !matches!(self.tile_size, 256 | 512)
            || self.minzoom > self.maxzoom
            || self.maxzoom > 24
            || self
                .vector_maxzoom
                .is_some_and(|zoom| zoom < self.minzoom || zoom > self.maxzoom)
            || self.bounds.is_some_and(|bbox| !valid_source_bbox(bbox))
            || self.coverage.as_ref().is_some_and(|coverage| {
                coverage.is_empty()
                    || coverage.len() > MAX_COVERAGE_BOXES
                    || coverage.iter().any(|bbox| !valid_source_bbox(*bbox))
            })
        {
            return false;
        }
        match &self.upstream {
            UpstreamTemplate::Xyz { url_template } | UpstreamTemplate::Wmts { url_template } => {
                valid_template(url_template, allow_http)
            }
            UpstreamTemplate::Wms {
                base,
                layers,
                styles,
                version,
                format,
                ..
            } => {
                clean_base_url(base, allow_http)
                    && valid_query_value(layers, MAX_WMS_LAYER_BYTES, false)
                    && valid_query_value(styles, MAX_WMS_STYLE_BYTES, true)
                    && version == "1.3.0"
                    && valid_query_value(format, MAX_WMS_FORMAT_BYTES, false)
            }
            UpstreamTemplate::Arcgis { base } => clean_base_url(base, allow_http),
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
                    && allowed_hosts.len() <= MAX_ALLOWED_HOSTS
                    && allowed_hosts.iter().all(|host| valid_host(host))
                    && allowed_hosts.iter().enumerate().all(|(index, host)| {
                        allowed_hosts[..index]
                            .iter()
                            .all(|other| !host.eq_ignore_ascii_case(other))
                    })
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
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return None;
    }
    reqwest::Url::parse(value).ok().filter(|url| {
        (url.scheme() == "https" || (allow_http && url.scheme() == "http"))
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

fn clean_base_url(value: &str, allow_http: bool) -> bool {
    valid_upstream_url(value, allow_http).is_some_and(|url| url.query().is_none())
}

fn valid_template(value: &str, allow_http: bool) -> bool {
    if !["{z}", "{x}", "{y}"]
        .iter()
        .all(|token| value.contains(token))
    {
        return false;
    }
    let expanded = value
        .replace("{z}", "0")
        .replace("{x}", "0")
        .replace("{y}", "0");
    !expanded.contains(['{', '}']) && valid_upstream_url(&expanded, allow_http).is_some()
}

fn valid_query_value(value: &str, max_bytes: usize, allow_empty: bool) -> bool {
    valid_bounded_text(value, max_bytes, allow_empty)
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        && !value.contains(['&', '?', '#'])
}

fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HOST_BYTES
        && !value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        && !value.contains(['/', '@', '?', '#', ':'])
}

fn valid_bounded_text(value: &str, max_bytes: usize, allow_empty: bool) -> bool {
    value.len() <= max_bytes
        && (allow_empty || !value.trim().is_empty())
        && !value
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\n' | '\r'))
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

    fn xyz_source() -> ChartSource {
        serde_json::from_str(
            r#"{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"xyz","urlTemplate":"https://h/{z}/{x}/{y}.png"}}"#,
        )
        .unwrap()
    }

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
        let UpstreamTemplate::Xyz { url_template } = &mut source.upstream else {
            unreachable!()
        };
        *url_template = "http://example.test/{z}/{x}/{y}/{date}".into();
        assert!(
            !source.is_valid(true),
            "unknown template tokens are rejected"
        );
        source.id = "../escape".into();
        assert!(!source.is_valid(true));

        let style: ChartSource = serde_json::from_str(
            r#"{"id":"style","title":"S","tileSize":512,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"style","styleUrl":"https://tiles.example.test/style.json","allowedHosts":["other.example.test"]}}"#,
        )
        .unwrap();
        assert!(!style.is_valid(false));

        let duplicate_style: ChartSource = serde_json::from_str(
            r#"{"id":"style","title":"S","tileSize":512,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"style","styleUrl":"https://tiles.example.test/style.json","allowedHosts":["tiles.example.test","TILES.EXAMPLE.TEST"]}}"#,
        )
        .unwrap();
        assert!(!duplicate_style.is_valid(false));
    }

    #[test]
    fn source_validation_rejects_query_injection_and_zero_span_boxes() {
        let source = |upstream: &str| -> ChartSource {
            serde_json::from_str(&format!(
                r#"{{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"","upstream":{upstream}}}"#
            ))
            .unwrap()
        };
        assert!(!source(
            r#"{"mode":"wms","base":"https://h/wms?token=x","layers":"layer","styles":"","version":"1.3.0","format":"image/png","transparent":true}"#
        ).is_valid(false));
        assert!(!source(
            r#"{"mode":"wms","base":"https://h/wms","layers":"layer&STYLES=evil","styles":"","version":"1.3.0","format":"image/png","transparent":true}"#
        ).is_valid(false));
        assert!(!source(
            r#"{"mode":"wms","base":"https://h/wms","layers":"layer","styles":"","version":"1.3.0","format":"image/png\nX-Evil: yes","transparent":true}"#
        ).is_valid(false));
        assert!(!source(
            r#"{"mode":"wms","base":"https://h/wms","layers":"layer","styles":"","version":"1.1.1","format":"image/png","transparent":true}"#
        ).is_valid(false));
        assert!(
            !source(r#"{"mode":"arcgis","base":"https://h/MapServer?token=x"}"#).is_valid(false)
        );

        let mut zero_span = xyz_source();
        zero_span.bounds = Some([180.0, -1.0, -180.0, 1.0]);
        assert!(!zero_span.is_valid(false));
    }

    #[test]
    fn source_validation_bounds_catalog_strings_and_collections() {
        let mut source = xyz_source();
        source.title = "t".repeat(MAX_TITLE_BYTES + 1);
        assert!(!source.is_valid(false));

        let mut source = xyz_source();
        source.attribution = "a".repeat(3_000);
        assert!(
            source.is_valid(false),
            "the shared Seascape attribution is roughly 3 KiB"
        );
        source.attribution = "a".repeat(MAX_ATTRIBUTION_BYTES + 1);
        assert!(!source.is_valid(false));

        let mut source = xyz_source();
        source.coverage = Some(vec![[-1.0, -1.0, 1.0, 1.0]; MAX_COVERAGE_BOXES + 1]);
        assert!(!source.is_valid(false));

        let mut source = xyz_source();
        let UpstreamTemplate::Xyz { url_template } = &mut source.upstream else {
            unreachable!()
        };
        *url_template = format!("https://h/{}/{{z}}/{{x}}/{{y}}", "u".repeat(MAX_URL_BYTES));
        assert!(!source.is_valid(false));

        let wms_json = r#"{"id":"w","title":"W","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
            "upstream":{"mode":"wms","base":"https://h/wms","layers":"layer","styles":"","version":"1.3.0","format":"image/png","transparent":true}}"#;
        for field in ["layers", "styles", "version", "format"] {
            let mut source: ChartSource = serde_json::from_str(wms_json).unwrap();
            let UpstreamTemplate::Wms {
                layers,
                styles,
                version,
                format,
                ..
            } = &mut source.upstream
            else {
                unreachable!()
            };
            match field {
                "layers" => *layers = "x".repeat(MAX_WMS_LAYER_BYTES + 1),
                "styles" => *styles = "x".repeat(MAX_WMS_STYLE_BYTES + 1),
                "version" => *version = "1.3.0-extra".into(),
                "format" => *format = "x".repeat(MAX_WMS_FORMAT_BYTES + 1),
                _ => unreachable!(),
            }
            assert!(!source.is_valid(false), "oversize WMS {field}");
        }

        let style_json = r#"{"id":"style","title":"S","tileSize":512,"minzoom":0,"maxzoom":18,"attribution":"",
            "upstream":{"mode":"style","styleUrl":"https://tiles.example.test/style.json","allowedHosts":["tiles.example.test"]}}"#;
        let mut source: ChartSource = serde_json::from_str(style_json).unwrap();
        let UpstreamTemplate::Style { allowed_hosts, .. } = &mut source.upstream else {
            unreachable!()
        };
        *allowed_hosts = vec!["tiles.example.test".into(); MAX_ALLOWED_HOSTS + 1];
        assert!(!source.is_valid(false));

        let mut source: ChartSource = serde_json::from_str(style_json).unwrap();
        let UpstreamTemplate::Style { allowed_hosts, .. } = &mut source.upstream else {
            unreachable!()
        };
        allowed_hosts[0] = "h".repeat(MAX_HOST_BYTES + 1);
        assert!(!source.is_valid(false));
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
