//! One HTTP response builder for a served tile, shared by the raster tile route and the basemap
//! vector-tile route so the status, ETag, Content-Type, Cache-Control, and stale-marker shape cannot
//! drift between the two.

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;

/// Cache-Control served for a cached tile (one day; the strong ETag drives revalidation).
pub const TILE_CACHE_CONTROL: &str = "public, max-age=86400";
pub const STALE_TILE_CACHE_CONTROL: &str = "public, max-age=0, must-revalidate";

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
    if if_none_match.is_some_and(|value| crate::fetcher::etag_matches(value, etag)) {
        let mut h = HeaderMap::new();
        insert_etag(&mut h, etag);
        h.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(if stale {
                STALE_TILE_CACHE_CONTROL
            } else {
                TILE_CACHE_CONTROL
            }),
        );
        if stale {
            h.insert("x-tilecache", HeaderValue::from_static("stale"));
        }
        return (StatusCode::NOT_MODIFIED, h).into_response();
    }
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, content_type_value(content_type));
    insert_etag(&mut h, etag);
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if stale {
            STALE_TILE_CACHE_CONTROL
        } else {
            TILE_CACHE_CONTROL
        }),
    );
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
}
