//! The vector basemap proxy. The container fetches the upstream style document, learns its glyph and
//! per-source vector-tile templates (fetching each source's TileJSON), rewrites the style so the glyphs
//! and tiles point back at the plugin, and serves the rewritten style. The glyph and tile sub-routes
//! reconstruct the upstream URL from the learned templates and fetch it, checked against the style's
//! allowed hosts (and the client's guarded DNS resolver). The vector tiles are cached through the tile
//! cache so the basemap geometry works offline. Sprite stays direct in v1 (a small visual degradation).

use crate::source::UpstreamTemplate;
use crate::state::{now_secs, AppState, StyleState};
use crate::cache::CachedTile;
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use serde_json::Value;
use std::collections::HashMap;

pub fn style_routes() -> Router<AppState> {
    Router::new()
        .route("/style/:source", get(style_doc))
        .route("/style/:source/glyphs/:fontstack/:range", get(glyphs))
        .route("/style/:source/tiles/:name/:z/:x/:y", get(vector_tile))
}

/// True when a URL's host is one the style is allowed to reference. Defense in depth on top of the
/// client's guarded DNS resolver, which already rejects private and loopback targets.
fn host_allowed(url: &str, allowed_hosts: &[String]) -> bool {
    match reqwest::Url::parse(url) {
        Ok(u) => u.host_str().map(|h| allowed_hosts.iter().any(|a| a.eq_ignore_ascii_case(h))).unwrap_or(false),
        Err(_) => false,
    }
}

async fn fetch_json(state: &AppState, url: &str) -> Option<Value> {
    let resp = state.guarded_get(url, None).await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = state.read_capped(resp).await?;
    serde_json::from_slice::<Value>(&body).ok()
}

async fn fetch_bytes(state: &AppState, url: &str) -> Option<(String, Bytes)> {
    let resp = state.guarded_get(url, None).await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let body = state.read_capped(resp).await?;
    Some((content_type, body))
}

/// GET /style/:source: fetch, learn, rewrite, and serve the basemap style.
async fn style_doc(State(state): State<AppState>, Path(source): Path<String>) -> Response {
    let (style_url, allowed) = {
        let map = state.sources.read().await;
        match map.get(&source).map(|s| s.upstream.clone()) {
            Some(UpstreamTemplate::Style { style_url, allowed_hosts }) => (style_url, allowed_hosts),
            _ => return StatusCode::NOT_FOUND.into_response(),
        }
    };

    if !host_allowed(&style_url, &allowed) {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let Some(mut style) = fetch_json(&state, &style_url).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let public = state.public_base.read().await.clone();

    // Learn the glyphs template, then rewrite it to the plugin path.
    let glyphs = style.get("glyphs").and_then(|v| v.as_str()).map(String::from);
    if glyphs.is_some() {
        style["glyphs"] = Value::String(format!("{public}/style/{source}/glyphs/{{fontstack}}/{{range}}.pbf"));
    }

    // For each source, resolve its tile templates (inline tiles, or its TileJSON), then rewrite.
    let mut source_tiles: HashMap<String, Vec<String>> = HashMap::new();
    let names: Vec<String> = style
        .get("sources")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    for name in &names {
        let src = style["sources"][name].clone();
        let tiles: Vec<String> = if let Some(arr) = src.get("tiles").and_then(|v| v.as_array()) {
            arr.iter().filter_map(|x| x.as_str().map(String::from)).collect()
        } else if let Some(url) = src.get("url").and_then(|v| v.as_str()) {
            if host_allowed(url, &allowed) {
                fetch_json(&state, url)
                    .await
                    .and_then(|tj| tj.get("tiles").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()))
                    .unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        if tiles.is_empty() {
            continue;
        }
        source_tiles.insert(name.clone(), tiles);
        if let Some(obj) = style["sources"][name].as_object_mut() {
            obj.remove("url");
            obj.insert(
                "tiles".to_string(),
                Value::Array(vec![Value::String(format!("{public}/style/{source}/tiles/{name}/{{z}}/{{x}}/{{y}}"))]),
            );
        }
    }

    state.style_state.write().await.insert(source.clone(), StyleState { glyphs, source_tiles });

    let body = match serde_json::to_vec(&style) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// GET /style/:source/glyphs/:fontstack/:range: reconstruct and proxy a glyph range (not persistently cached in v1).
async fn glyphs(State(state): State<AppState>, Path((source, fontstack, range)): Path<(String, String, String)>) -> Response {
    let template = { state.style_state.read().await.get(&source).and_then(|s| s.glyphs.clone()) };
    let Some(template) = template else { return StatusCode::NOT_FOUND.into_response() };
    let allowed = style_allowed_hosts(&state, &source).await;
    // The learned template carries literal {fontstack} and {range}.pbf, so the incoming range (which
    // already ends in .pbf) replaces the whole {range}.pbf token.
    let upstream = template.replace("{fontstack}", &fontstack).replace("{range}.pbf", &range);
    if !host_allowed(&upstream, &allowed) {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    match fetch_bytes(&state, &upstream).await {
        Some((content_type, body)) => ([(header::CONTENT_TYPE, content_type)], body).into_response(),
        None => StatusCode::BAD_GATEWAY.into_response(),
    }
}

/// GET /style/:source/tiles/:name/:z/:x/:y: serve a basemap vector tile, cached through the tile cache.
async fn vector_tile(State(state): State<AppState>, Path((source, name, z, x, y)): Path<(String, String, u32, u32, u32)>, headers: HeaderMap) -> Response {
    let template = {
        state.style_state.read().await.get(&source).and_then(|s| s.source_tiles.get(&name).and_then(|t| t.first().cloned()))
    };
    let Some(template) = template else { return StatusCode::NOT_FOUND.into_response() };
    let cache_source = format!("style:{source}:{name}");
    let if_none_match = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).map(str::to_string);

    // Cache first (also the offline path: serve a cached tile when the upstream is unreachable).
    if let Ok(Some(tile)) = state.cache.get(&cache_source, z, x, y) {
        if tile.status == 200 {
            if now_secs() - tile.last_access >= crate::fetcher::TOUCH_THROTTLE_SECS {
                crate::fetcher::log_cache_err(state.cache.touch(&cache_source, z, x, y, now_secs()));
            }
            return tile_response(&tile, if_none_match.as_deref());
        }
    }

    let allowed = style_allowed_hosts(&state, &source).await;
    let upstream = template.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string());
    if !host_allowed(&upstream, &allowed) {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    match fetch_bytes(&state, &upstream).await {
        Some((content_type, body)) => {
            let now = now_secs();
            let tile = CachedTile {
                content_type,
                strong_etag: crate::fetcher::strong_etag(&body),
                upstream_validator: None,
                status: 200,
                fetched_at: now,
                last_access: now,
                bytes: body.len() as i64,
                blob: Some(body),
            };
            crate::fetcher::log_cache_err(state.cache.put(&cache_source, z, x, y, &tile, now));
            crate::fetcher::log_cache_err(state.cache.evict_to(state.knobs.cap_bytes));
            tile_response(&tile, if_none_match.as_deref())
        }
        None => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn style_allowed_hosts(state: &AppState, source: &str) -> Vec<String> {
    match state.sources.read().await.get(source).map(|s| s.upstream.clone()) {
        Some(UpstreamTemplate::Style { allowed_hosts, .. }) => allowed_hosts,
        _ => Vec::new(),
    }
}

fn tile_response(tile: &CachedTile, if_none_match: Option<&str>) -> Response {
    crate::response::tile_http_response(&tile.content_type, &tile.strong_etag, false, tile.blob.clone().unwrap_or_default(), if_none_match)
}

#[cfg(test)]
mod tests {
    use crate::cache::TileCache;
    use crate::routes::app;
    use crate::state::{AppState, Knobs};
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use axum::response::Response;
    use axum::routing::get;
    use axum::Router;
    use http_body_util::BodyExt;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    async fn spawn_upstream() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let a = addr;
        let stub = Router::new()
            .route(
                "/style",
                get(move || async move {
                    let body = format!(
                        r#"{{"version":8,"glyphs":"http://{a}/fonts/{{fontstack}}/{{range}}.pbf","sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[]}}"#
                    );
                    ([(header::CONTENT_TYPE, "application/json")], body)
                }),
            )
            .route(
                "/tiles.json",
                get(move || async move {
                    ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"]}}"#))
                }),
            )
            .route("/fonts/:fontstack/:range", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![7u8, 7, 7]) }))
            .route("/t/:z/:x/:y", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![8u8, 8, 8, 8]) }));
        tokio::spawn(async move { axum::serve(listener, stub).await.unwrap(); });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn dev_state(db: &NamedTempFile) -> AppState {
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        AppState::new(cache, Knobs { allow_private_egress: true, ..Default::default() })
    }

    fn config_json(addr: SocketAddr, allowed_host: &str) -> String {
        format!(
            r#"{{"sources":[{{"id":"basemap","title":"B","tileSize":256,"minzoom":0,"maxzoom":20,"attribution":"",
                "upstream":{{"mode":"style","styleUrl":"http://{addr}/style","allowedHosts":["{allowed_host}"]}}}}],"publicBase":"/plugins/p"}}"#
        )
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn style_is_rewritten_and_its_tiles_and_glyphs_proxy() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap())
            .await
            .unwrap();

        // The style document is rewritten so its glyphs and tiles point back at the plugin.
        let style_resp = router.clone().oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(style_resp.status(), StatusCode::OK);
        let style = body_json(style_resp).await;
        assert_eq!(style["glyphs"], "/plugins/p/style/basemap/glyphs/{fontstack}/{range}.pbf");
        assert_eq!(style["sources"]["openmaptiles"]["tiles"][0], "/plugins/p/style/basemap/tiles/openmaptiles/{z}/{x}/{y}");
        assert!(style["sources"]["openmaptiles"].get("url").is_none(), "the upstream url is replaced by the proxied tiles");

        // A vector tile is fetched, cached, and served.
        let tile = router.clone().oneshot(Request::get("/style/basemap/tiles/openmaptiles/0/0/0").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(tile.status(), StatusCode::OK);
        assert_eq!(tile.headers().get(header::CONTENT_TYPE).unwrap(), "application/x-protobuf");

        // A glyph range is proxied.
        let glyph = router.oneshot(Request::get("/style/basemap/glyphs/NotoSans/0-255.pbf").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(glyph.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_style_url_off_the_allowed_hosts_is_rejected() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "not-allowed.example"))).unwrap())
            .await
            .unwrap();
        let resp = router.oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY, "the style host is not in allowedHosts");
    }
}
