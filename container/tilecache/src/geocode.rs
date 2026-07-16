//! Reverse-geocode proxy. Targets the hardcoded allowlisted host nominatim.openstreetmap.org
//! only, via the v2 SSRF guards (IP literal check, guarded DNS resolver, redirects off, body cap).
//! The User-Agent is identifiable and contactable per the Nominatim usage policy. The server enforces
//! the provider's application-wide one-request-per-second limit and caches rounded
//! coordinate lookups, so multiple clients cannot bypass the policy.

use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub(crate) const NOMINATIM_HOST: &str = "nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT: &str =
    "signalk-chart-locker geocoder (+https://github.com/NearlCrews/signalk-chart-locker)";
const GEOCODE_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const GEOCODE_CACHE_LIMIT: usize = 256;
const NOMINATIM_INTERVAL: Duration = Duration::from_secs(1);
const GEOCODE_RESPONSE_MAX_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub(crate) struct GeocodeState {
    last_request: Option<Instant>,
    cache: HashMap<String, (Instant, bytes::Bytes)>,
}

pub fn geocode_routes() -> Router<AppState> {
    Router::new().route("/geocode", get(geocode))
}

#[derive(Deserialize)]
struct GeocodeQuery {
    lat: Option<f64>,
    lon: Option<f64>,
}

/// True when the URL's host is exactly nominatim.openstreetmap.org (case-insensitive).
pub(crate) fn host_is_nominatim(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case(NOMINATIM_HOST)))
        .unwrap_or(false)
}

fn valid_geocode_body(body: &[u8]) -> bool {
    body.len() <= GEOCODE_RESPONSE_MAX_BYTES
        && serde_json::from_slice::<serde_json::Value>(body).is_ok()
}

async fn geocode(State(st): State<AppState>, Query(q): Query<GeocodeQuery>) -> Response {
    if !st.geocoding_enabled.load(Ordering::Relaxed) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (lat, lon) = match (q.lat, q.lon) {
        (Some(la), Some(lo))
            if la.is_finite() && lo.is_finite() && la.abs() <= 90.0 && lo.abs() <= 180.0 =>
        {
            (la, lo)
        }
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    // Five decimal places are roughly meter scale and make repeated clicks around the same point share
    // one policy-compliant provider lookup.
    let key = format!("{lat:.5},{lon:.5}");
    let mut geocode_state = st.geocode_state.lock().await;
    let now = Instant::now();
    geocode_state
        .cache
        .retain(|_, (stored, _)| now.duration_since(*stored) < GEOCODE_CACHE_TTL);
    if let Some((_, body)) = geocode_state.cache.get(&key) {
        return ([(header::CONTENT_TYPE, "application/json")], body.clone()).into_response();
    }
    if let Some(last) = geocode_state.last_request {
        let wait = NOMINATIM_INTERVAL.saturating_sub(now.duration_since(last));
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
    geocode_state.last_request = Some(Instant::now());
    let url = format!(
        "https://{}/reverse?format=jsonv2&lat={:.5}&lon={:.5}",
        NOMINATIM_HOST, lat, lon
    );
    // Defense in depth: confirm the built URL still targets the allowlisted host.
    if !host_is_nominatim(&url) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // Reuse the shared guarded egress path (IP-literal guard, egress permit, redirects off) with the
    // contactable User-Agent the Nominatim policy requires, overriding the client-level tile-cache UA.
    // A blocked literal, an exhausted permit, or a transport error all collapse to a 502 here.
    let resp = match st
        .guarded_get_with_headers(
            &url,
            &[(reqwest::header::USER_AGENT, NOMINATIM_USER_AGENT)],
            None,
        )
        .await
    {
        Ok(r) => r,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    if !resp.status().is_success() {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let body = match st.read_capped_to(resp, GEOCODE_RESPONSE_MAX_BYTES).await {
        Some(b) => b,
        None => return StatusCode::BAD_GATEWAY.into_response(),
    };
    if !valid_geocode_body(&body) {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    if geocode_state.cache.len() >= GEOCODE_CACHE_LIMIT {
        if let Some(oldest) = geocode_state
            .cache
            .iter()
            .min_by_key(|(_, (stored, _))| *stored)
            .map(|(key, _)| key.clone())
        {
            geocode_state.cache.remove(&oldest);
        }
    }
    geocode_state
        .cache
        .insert(key, (Instant::now(), body.clone()));
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::TileCache;
    use crate::routes::app;
    use crate::state::{AppState, Knobs};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tower::ServiceExt;

    fn dev_state(db: &NamedTempFile) -> AppState {
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        AppState::new(
            cache,
            Knobs {
                allow_private_egress: true,
                ..Default::default()
            },
        )
    }

    #[tokio::test]
    async fn geocode_returns_400_for_missing_or_invalid_lat_lon() {
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        // Missing lat.
        let r = router
            .clone()
            .oneshot(
                Request::get("/geocode?lon=-122.4")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r.status(),
            StatusCode::BAD_REQUEST,
            "missing lat must be 400"
        );
        // Missing lon.
        let r2 = router
            .clone()
            .oneshot(
                Request::get("/geocode?lat=37.7")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r2.status(),
            StatusCode::BAD_REQUEST,
            "missing lon must be 400"
        );
        // Out-of-range lat (> 90).
        let r3 = router
            .clone()
            .oneshot(
                Request::get("/geocode?lat=91.0&lon=-122.4")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r3.status(), StatusCode::BAD_REQUEST, "lat > 90 must be 400");
        // Out-of-range lon (> 180).
        let r4 = router
            .oneshot(
                Request::get("/geocode?lat=37.7&lon=181.0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            r4.status(),
            StatusCode::BAD_REQUEST,
            "lon > 180 must be 400"
        );
    }

    #[test]
    fn host_is_nominatim_accepts_only_the_allowlisted_host() {
        assert!(host_is_nominatim(&format!(
            "https://{}/reverse?format=jsonv2&lat=37.77&lon=-122.41",
            NOMINATIM_HOST
        )));
        assert!(!host_is_nominatim("https://evil.example/reverse"));
        assert!(!host_is_nominatim(
            "https://nominatim.openstreetmap.org.evil.example/reverse"
        ));
    }

    #[test]
    fn geocode_body_validation_rejects_malformed_and_oversize_payloads() {
        assert!(valid_geocode_body(br#"{"display_name":"Port"}"#));
        assert!(!valid_geocode_body(b"not json"));
        assert!(!valid_geocode_body(&vec![
            b' ';
            GEOCODE_RESPONSE_MAX_BYTES + 1
        ]));
    }

    #[tokio::test]
    async fn disabled_geocoding_is_hidden() {
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        st.geocoding_enabled.store(false, Ordering::Release);
        let response = app(st)
            .oneshot(
                Request::get("/geocode?lat=37.7&lon=-122.4")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
