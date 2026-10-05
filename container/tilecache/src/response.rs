//! One HTTP response builder for a served tile, shared by the raster tile route and the basemap
//! vector-tile route so the status, ETag, Content-Type, Cache-Control, and stale-marker shape cannot
//! drift between the two, plus the If-None-Match extractor those routes share.

use axum::extract::FromRequestParts;
use axum::http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;

/// The client's If-None-Match, forwarded by the plugin proxy, so a revalidating browser gets a 304
/// rather than the whole tile, glyph range, sprite, or style again. The extractor copies this one
/// header, where a `HeaderMap` extractor would clone every request header.
pub(crate) struct IfNoneMatch(pub(crate) Option<String>);

impl<S: Send + Sync> FromRequestParts<S> for IfNoneMatch {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .headers
                .get(header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        ))
    }
}

/// Cache-Control served for a cached tile (one day; the strong ETag drives revalidation).
pub const TILE_CACHE_CONTROL: &str = "public, max-age=86400";
pub const STALE_TILE_CACHE_CONTROL: &str = "public, max-age=0, must-revalidate";

/// The Cache-Control value for a served tile. A stale tile must always be revalidated. A tile from a
/// time-dynamic source carries that source's own TTL, because the browser and the webapp's service
/// worker are caches too: serving a five-minute radar frame with a one-day lifetime would leave a
/// day-old storm on the chart no matter how correctly the container expires its own copy.
fn cache_control(stale: bool, max_age_secs: Option<u64>) -> HeaderValue {
    if stale {
        return HeaderValue::from_static(STALE_TILE_CACHE_CONTROL);
    }
    match max_age_secs {
        Some(secs) => HeaderValue::try_from(format!("public, max-age={secs}"))
            .unwrap_or_else(|_| HeaderValue::from_static(STALE_TILE_CACHE_CONTROL)),
        None => HeaderValue::from_static(TILE_CACHE_CONTROL),
    }
}

/// The browser lifetime left for a tile of a time-dynamic source: its declared TTL less the time
/// since the container fetched the bytes. Granting the whole TTL to a tile served near the end of
/// its window would let the browser hold it for almost twice the source's own limit. None for a
/// static source, which keeps the fixed one-day lifetime.
pub fn remaining_max_age(max_age_secs: Option<u64>, fetched_at: i64, now: i64) -> Option<u64> {
    let age = u64::try_from(now.saturating_sub(fetched_at)).unwrap_or(0);
    max_age_secs.map(|ttl| ttl.saturating_sub(age))
}

/// A Content-Type header value, falling back to a generic binary type when the string is not a legal
/// header value. This fallback is meaningful only for Content-Type; other headers (the ETag) omit
/// themselves rather than borrow this content-type default.
fn content_type_value(s: &str) -> HeaderValue {
    HeaderValue::from_str(s)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
}

/// Insert the ETag header when the value is a legal header value; omit it rather than fall back to a
/// stand-in, since a wrong ETag is worse than none.
fn insert_etag(h: &mut HeaderMap, etag: &str) {
    if let Ok(v) = HeaderValue::from_str(etag) {
        h.insert(header::ETAG, v);
    }
}

/// Build the response for a served tile: 304 when the client ETag matches, else 200 with the body and
/// the cache headers. `stale` adds the X-Tilecache marker.
pub fn tile_http_response(
    content_type: &str,
    etag: &str,
    stale: bool,
    body: Bytes,
    if_none_match: Option<&str>,
) -> Response {
    tile_http_response_with_max_age(content_type, etag, stale, body, if_none_match, None)
}

/// As `tile_http_response`, with the source's own freshness window for a time-dynamic source.
pub fn tile_http_response_with_max_age(
    content_type: &str,
    etag: &str,
    stale: bool,
    body: Bytes,
    if_none_match: Option<&str>,
    max_age_secs: Option<u64>,
) -> Response {
    if if_none_match.is_some_and(|value| crate::fetcher::etag_matches(value, etag)) {
        let mut h = HeaderMap::new();
        insert_etag(&mut h, etag);
        h.insert(header::CACHE_CONTROL, cache_control(stale, max_age_secs));
        if stale {
            h.insert("x-tilecache", HeaderValue::from_static("stale"));
        }
        return (StatusCode::NOT_MODIFIED, h).into_response();
    }
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, content_type_value(content_type));
    insert_etag(&mut h, etag);
    h.insert(header::CACHE_CONTROL, cache_control(stale, max_age_secs));
    if stale {
        h.insert("x-tilecache", HeaderValue::from_static("stale"));
    }
    (StatusCode::OK, h, body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_not_modified_keeps_validator_and_revalidation_headers() {
        let response = tile_http_response(
            "image/png",
            "\"current\"",
            true,
            Bytes::from_static(b"body"),
            Some("\"other\", W/\"current\""),
        );
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::ETAG], "\"current\"");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            STALE_TILE_CACHE_CONTROL,
        );
        assert_eq!(response.headers()["x-tilecache"], "stale");
    }

    #[test]
    fn remaining_max_age_spends_the_window_from_the_fetch_time() {
        assert_eq!(remaining_max_age(Some(300), 1_000, 1_000), Some(300));
        assert_eq!(remaining_max_age(Some(300), 1_000, 1_200), Some(100));
        assert_eq!(remaining_max_age(Some(300), 1_000, 5_000), Some(0));
        // A clock step backwards never extends the window past the declared TTL.
        assert_eq!(remaining_max_age(Some(300), 1_000, 900), Some(300));
        assert_eq!(remaining_max_age(None, 1_000, 1_200), None);
    }

    #[test]
    fn fresh_response_uses_the_normal_cache_policy() {
        let response = tile_http_response(
            "image/png",
            "\"current\"",
            false,
            Bytes::from_static(b"body"),
            None,
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            TILE_CACHE_CONTROL
        );
        assert!(!response.headers().contains_key("x-tilecache"));
    }

    #[test]
    fn a_time_dynamic_source_tells_the_browser_its_own_freshness_window() {
        // The browser and the webapp's service worker cache this response too, so a five-minute
        // radar frame must not be handed out with the one-day tile policy.
        let response = tile_http_response_with_max_age(
            "image/png",
            "\"current\"",
            false,
            Bytes::from_static(b"body"),
            None,
            Some(300),
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=300"
        );

        // A stale tile still has to be revalidated, whatever the source's window says.
        let stale = tile_http_response_with_max_age(
            "image/png",
            "\"current\"",
            true,
            Bytes::from_static(b"body"),
            None,
            Some(300),
        );
        assert_eq!(
            stale.headers()[header::CACHE_CONTROL],
            STALE_TILE_CACHE_CONTROL
        );

        // A static source keeps the ordinary policy.
        let static_source = tile_http_response_with_max_age(
            "image/png",
            "\"current\"",
            false,
            Bytes::from_static(b"body"),
            None,
            None,
        );
        assert_eq!(
            static_source.headers()[header::CACHE_CONTROL],
            TILE_CACHE_CONTROL
        );
    }
}
