//! One HTTP response builder for a served tile, shared by the raster tile route and the basemap
//! vector-tile route so the status, ETag, Content-Type, Cache-Control, and stale-marker shape cannot
//! drift between the two.

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;

/// Cache-Control served for a cached tile (one day; the strong ETag drives revalidation).
pub const TILE_CACHE_CONTROL: &str = "public, max-age=86400";

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
    if if_none_match == Some(etag) {
        let mut h = HeaderMap::new();
        insert_etag(&mut h, etag);
        return (StatusCode::NOT_MODIFIED, h).into_response();
    }
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, content_type_value(content_type));
    insert_etag(&mut h, etag);
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(TILE_CACHE_CONTROL),
    );
    if stale {
        h.insert("x-tilecache", HeaderValue::from_static("stale"));
    }
    (StatusCode::OK, h, body).into_response()
}
