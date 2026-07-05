//! Reverse-geocode proxy. Targets the hardcoded allowlisted host nominatim.openstreetmap.org
//! only, via the v2 SSRF guards (IP literal check, guarded DNS resolver, redirects off, body cap).
//! The User-Agent is identifiable and contactable per the Nominatim usage policy. The lookup fires
//! at most once per Download action; the panel never triggers it on rectangle drag. The panel's
//! once-per-Download debounce IS the rate control for the Nominatim 1 request per second policy:
//! the egress semaphore bounds concurrency, not rate, but geocode fires only at Download time, so a
//! standing server-side rate limiter is unnecessary.

use crate::state::AppState;
use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;

pub(crate) const NOMINATIM_HOST: &str = "nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT: &str =
    "signalk-chart-locker geocoder (+https://github.com/NearlCrews/signalk-chart-locker)";

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

async fn geocode(State(st): State<AppState>, Query(q): Query<GeocodeQuery>) -> Response {
    let (lat, lon) = match (q.lat, q.lon) {
        (Some(la), Some(lo))
            if la.is_finite() && lo.is_finite() && la.abs() <= 90.0 && lo.abs() <= 180.0 =>
        {
            (la, lo)
        }
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    let url = format!(
        "https://{}/reverse?format=jsonv2&lat={:.6}&lon={:.6}",
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
    let body = match st.read_capped(resp).await {
        Some(b) => b,
        None => return StatusCode::BAD_GATEWAY.into_response(),
    };
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
}
