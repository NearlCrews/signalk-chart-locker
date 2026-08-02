//! The Rust mirror of the shared `ChartSource` and `UpstreamTemplate`, deserialized from the plugin
//! `POST /config` payload (camelCase JSON from the `signalk-chart-sources` package). The
//! container holds only this; it never reads Signal K.

use serde::Deserialize;
use std::net::IpAddr;

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
    /// How long a fetched tile of this source stays usable, in seconds. Absent means the source is
    /// static and a stored tile keeps until the ordinary freshness window expires. Present means the
    /// source is time-dynamic (weather radar, hazard overlays) and the cache must both shorten its
    /// freshness window to this and refuse to warm it: a persistent cache handing back a storm
    /// image from three days ago is worse than handing back nothing.
    #[serde(default)]
    pub max_age_seconds: Option<u64>,
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
    /// True when the source is time-dynamic, so its tiles must not be pre-warmed into the cache.
    pub fn is_volatile(&self) -> bool {
        self.max_age_seconds.is_some()
    }

    /// The freshness window to apply to this source's cached tiles, in seconds. A declared TTL is a
    /// ceiling on the deployment-wide default rather than a replacement for it: an operator who
    /// shortened the default wants more revalidation, not less.
    pub fn fresh_secs(&self, default_secs: i64) -> i64 {
        self.clamped_to_ttl(default_secs)
    }

    /// How long a stored tile of this source may still be served after it stops being fresh, when the
    /// upstream cannot be reached. The deployment default is generous because a chart tile does not
    /// change; a time-dynamic source is clamped to its own TTL instead, because an hours-old hazard
    /// overlay presented as the current one is worse than an empty layer.
    pub fn max_stale_secs(&self, default_secs: i64) -> i64 {
        self.clamped_to_ttl(default_secs)
    }

    /// A deployment-wide window narrowed by this source's declared TTL, if it declares one. A TTL past
    /// `i64` cannot overflow the comparison into a negative window, which would make every stored tile
    /// look permanently expired.
    fn clamped_to_ttl(&self, default_secs: i64) -> i64 {
        match self.max_age_seconds {
            Some(ttl) => default_secs.min(i64::try_from(ttl).unwrap_or(i64::MAX)),
            None => default_secs,
        }
    }

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
            || self.max_age_seconds == Some(0)
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
                    && allowed_hosts
                        .iter()
                        .all(|host| valid_host(host, allow_http))
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

/// The host with any IPv6 brackets removed, as an address if it is an address literal at all. The URL
/// parser normalizes the decimal, octal, and hexadecimal spellings of an IPv4 host, so a literal
/// written any of those ways arrives here in dotted-quad form.
fn host_as_ip(host: &str) -> Option<IpAddr> {
    host.trim_matches(['[', ']']).parse::<IpAddr>().ok()
}

/// A loopback host in either spelling the package rejects: the reserved name (RFC 6761 reserves
/// `localhost` and every name under it) or an address literal in a loopback range.
fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .rsplit_once('.')
            .is_some_and(|(_, last)| last.eq_ignore_ascii_case("localhost"))
        || host_as_ip(host).is_some_and(|address| address.is_loopback())
}

/// The shape signalk-chart-sources requires of every URL field as of 0.7.0: a named host, no port,
/// and no loopback name. Mirrored here so version skew or a direct config push cannot install what
/// the package boundary would have refused. It is parity rather than the live guard: `ssrf.rs` still
/// checks every resolved address before connecting.
fn matches_package_url_shape(url: &reqwest::Url) -> bool {
    url.port().is_none()
        && url.host_str().is_some_and(|host| {
            host_as_ip(host).is_none() && !is_loopback_host(host) && !host.is_empty()
        })
}

fn valid_upstream_url(value: &str, allow_http: bool) -> Option<reqwest::Url> {
    if value.is_empty()
        || value.len() > MAX_URL_BYTES
        || value.contains('#')
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return None;
    }
    reqwest::Url::parse(value).ok().filter(|url| {
        // The dev and test escape hatch, and the only reason a loopback target or an explicit port
        // ever reaches here. Production leaves allow_http false and gets the package shape.
        let local_http =
            url.scheme() == "http" && allow_http && url.host_str().is_some_and(is_loopback_host);
        (url.scheme() == "https" || local_http)
            && (local_http || matches_package_url_shape(url))
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

fn clean_base_url(value: &str, allow_http: bool) -> bool {
    !value.contains('?')
        && valid_upstream_url(value, allow_http).is_some_and(|url| url.query().is_none())
}

fn valid_template(value: &str, allow_http: bool) -> bool {
    let host_has_token = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
        .is_some_and(|host| host.contains(['{', '}']));
    if host_has_token
        || !["{z}", "{x}", "{y}"]
            .iter()
            .all(|token| value.matches(token).count() == 1)
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
        && !value.contains(['&', '?', '#', '+'])
}

/// One entry of a style source's allowed-host list. The colon rejection already excludes a port and
/// an IPv6 literal; the package also rejects an IPv4 literal and a loopback name, so those go too
/// unless the dev and test escape hatch is open (the loopback stub upstream needs them).
fn valid_host(value: &str, allow_local: bool) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HOST_BYTES
        && !value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        && !value.contains(['/', '@', '?', '#', ':'])
        && (allow_local || (host_as_ip(value).is_none() && !is_loopback_host(value)))
}

fn valid_bounded_text(value: &str, max_bytes: usize, allow_empty: bool) -> bool {
    value.len() <= max_bytes
        && ((allow_empty && value.is_empty()) || !value.trim().is_empty())
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
    fn deserializes_max_age_seconds_and_reports_a_source_as_volatile() {
        let volatile: ChartSource = serde_json::from_str(
            r#"{"id":"weather-radar-conus","title":"R","tileSize":256,"minzoom":0,"maxzoom":10,
                "maxAgeSeconds":300,"attribution":"NOAA",
                "upstream":{"mode":"xyz","urlTemplate":"https://h/{z}/{x}/{y}.png"}}"#,
        )
        .unwrap();
        assert_eq!(volatile.max_age_seconds, Some(300));
        assert!(volatile.is_volatile());
        assert!(volatile.is_valid(false));

        // Absent is the common case, and must not be read as a zero-second TTL.
        let static_source = xyz_source();
        assert_eq!(static_source.max_age_seconds, None);
        assert!(!static_source.is_volatile());
    }

    #[test]
    fn a_declared_ttl_shortens_the_default_freshness_window_but_never_extends_it() {
        let mut source = xyz_source();
        assert_eq!(
            source.fresh_secs(86_400),
            86_400,
            "no TTL keeps the default"
        );

        source.max_age_seconds = Some(300);
        assert_eq!(source.fresh_secs(86_400), 300, "a TTL shortens the default");
        // An operator who lowered the deployment default wants more revalidation, not less, so the
        // TTL is a ceiling rather than a replacement.
        assert_eq!(source.fresh_secs(60), 60, "a shorter default still wins");

        // A TTL past i64 cannot overflow the comparison into a negative window, which would make
        // every stored tile look permanently stale.
        source.max_age_seconds = Some(u64::MAX);
        assert_eq!(source.fresh_secs(86_400), 86_400);
    }

    // signalk-chart-sources 0.7.0 rejects a port, an address literal, and a loopback name in every
    // URL field. The container re-validates the pushed catalog so version skew or a direct push
    // cannot install what the package boundary would have refused, so the two rule sets must agree.
    #[test]
    fn production_validation_rejects_ports_address_literals_and_loopback_names() {
        let with_template = |template: &str| {
            let source: ChartSource = serde_json::from_str(&format!(
                r#"{{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                    "upstream":{{"mode":"xyz","urlTemplate":"{template}"}}}}"#
            ))
            .unwrap();
            source.is_valid(false)
        };
        assert!(with_template("https://tiles.example/{z}/{x}/{y}.png"));
        for rejected in [
            "https://tiles.example:8443/{z}/{x}/{y}.png",
            "https://203.0.113.7/{z}/{x}/{y}.png",
            "https://[2606:4700::1]/{z}/{x}/{y}.png",
            // The URL parser normalizes these spellings to a dotted quad, so they are the same host.
            "https://0x7f000001/{z}/{x}/{y}.png",
            "https://localhost/{z}/{x}/{y}.png",
            "https://tiles.localhost/{z}/{x}/{y}.png",
        ] {
            assert!(!with_template(rejected), "{rejected} must be rejected");
        }

        // The dev and test escape hatch still admits the loopback stub upstream, port and all: the
        // Node contract test pushes one under TILECACHE_ALLOW_PRIVATE=1.
        let loopback: ChartSource = serde_json::from_str(
            r#"{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{"mode":"wms","base":"http://127.0.0.1:8080/wms","layers":"a","styles":"","version":"1.3.0","format":"image/png","transparent":true}}"#,
        )
        .unwrap();
        assert!(loopback.is_valid(true));
        assert!(!loopback.is_valid(false));
    }

    #[test]
    fn production_validation_rejects_an_address_literal_allowed_host() {
        let style = |host: &str| {
            let source: ChartSource = serde_json::from_str(&format!(
                r#"{{"id":"b","title":"B","tileSize":256,"minzoom":0,"maxzoom":20,"attribution":"",
                    "upstream":{{"mode":"style","styleUrl":"https://tiles.example/s","allowedHosts":["tiles.example","{host}"]}}}}"#
            ))
            .unwrap();
            source.is_valid(false)
        };
        assert!(style("fonts.example"));
        assert!(!style("203.0.113.7"));
        assert!(!style("localhost"));
        assert!(!style("cdn.localhost"));
    }

    #[test]
    fn source_validation_rejects_a_zero_second_ttl() {
        // Zero would mean "never fresh", which is a config mistake rather than a cache policy: it
        // would refetch the source on every single tile read.
        let mut source = xyz_source();
        source.max_age_seconds = Some(0);
        assert!(!source.is_valid(false));
        source.max_age_seconds = Some(1);
        assert!(source.is_valid(false));
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
                "upstream":{"mode":"xyz","urlTemplate":"http://127.0.0.1/{z}/{x}/{y}"}}"#,
        )
        .unwrap();
        assert!(!source.is_valid(false), "production requires HTTPS");
        assert!(
            source.is_valid(true),
            "controlled tests permit local HTTP stubs"
        );
        let set_template = |source: &mut ChartSource, value: &str| {
            let UpstreamTemplate::Xyz { url_template } = &mut source.upstream else {
                unreachable!()
            };
            *url_template = value.into();
        };
        set_template(&mut source, "http://127.0.0.1/{z}/{x}/{y}/{date}");
        assert!(
            !source.is_valid(true),
            "unknown template tokens are rejected"
        );
        set_template(&mut source, "http://example.test/{z}/{x}/{y}");
        assert!(
            !source.is_valid(true),
            "the test escape hatch permits only loopback HTTP"
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
    fn source_validation_matches_chart_sources_0_5_url_and_text_rules() {
        let source = |upstream: &str| -> ChartSource {
            serde_json::from_str(&format!(
                r#"{{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"","upstream":{upstream}}}"#
            ))
            .unwrap()
        };

        for upstream in [
            r#"{"mode":"xyz","urlTemplate":"https://h/{z}/{x}/{y}#"}"#,
            r#"{"mode":"style","styleUrl":"https://h/style.json#","allowedHosts":["h"]}"#,
            r#"{"mode":"wms","base":"https://h/wms?","layers":"layer","styles":"","version":"1.3.0","format":"image/png","transparent":true}"#,
            r#"{"mode":"arcgis","base":"https://h/MapServer?"}"#,
            r#"{"mode":"xyz","urlTemplate":"https://{x}.h/{z}/{x}/{y}.png"}"#,
        ] {
            assert!(!source(upstream).is_valid(false), "{upstream}");
        }

        for token in ["{z}", "{x}", "{y}"] {
            let template = format!("https://h/{{z}}/{{x}}/{{y}}/{token}.png");
            let upstream = serde_json::json!({ "mode": "xyz", "urlTemplate": template });
            assert!(
                !source(&upstream.to_string()).is_valid(false),
                "duplicate {token}"
            );
        }

        let wms = |field: &str, value: &str| {
            let mut upstream = serde_json::json!({
                "mode": "wms",
                "base": "https://h/wms",
                "layers": "layer",
                "styles": "",
                "version": "1.3.0",
                "format": "image/png",
                "transparent": true
            });
            upstream[field] = value.into();
            source(&upstream.to_string())
        };
        for (field, value) in [
            ("layers", "a+b"),
            ("styles", "a+b"),
            ("format", "image+png"),
        ] {
            assert!(!wms(field, value).is_valid(false), "WMS {field}");
        }

        let mut whitespace = xyz_source();
        whitespace.attribution = " \t\r\n ".into();
        assert!(!whitespace.is_valid(false));
        whitespace.attribution.clear();
        assert!(whitespace.is_valid(false));
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
