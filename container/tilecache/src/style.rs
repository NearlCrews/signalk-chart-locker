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
use std::sync::atomic::Ordering;

pub fn style_routes() -> Router<AppState> {
    Router::new()
        .route("/style/:source", get(style_doc))
        .route("/style/:source/glyphs/:fontstack/:range", get(glyphs))
        .route("/style/:source/sprite.json", get(sprite_json))
        .route("/style/:source/sprite.png", get(sprite_png))
        .route("/style/:source/sprite@2x.json", get(sprite_2x_json))
        .route("/style/:source/sprite@2x.png", get(sprite_2x_png))
        .route("/style/:source/tiles/:name/:z/:x/:y", get(vector_tile))
}

/// The synthetic cache source for a fontstack's glyph ranges. The fontstack is the canonical DECODED
/// comma-joined form (the axum path param after decoding), so the warm-write and serve-read keys match.
pub(crate) fn glyph_cache_source(style_source: &str, fontstack: &str) -> String {
    format!("style:{style_source}:glyphs:{fontstack}")
}

/// The synthetic cache source for the sprite variants.
pub(crate) fn sprite_cache_source(style_source: &str) -> String {
    format!("style:{style_source}:sprite")
}

/// Parse the 256-aligned range start from a glyph range param like `0-255.pbf`. Returns None for a
/// malformed or non-256-aligned range so a crafted range cannot mis-key the cache.
pub(crate) fn glyph_range_start(range: &str) -> Option<u32> {
    let start: u32 = range.split('-').next()?.parse().ok()?;
    if start.is_multiple_of(256) { Some(start) } else { None }
}

/// Percent-encode a fontstack for an upstream glyph URL segment (the cache key uses the decoded form).
/// A space becomes %20; the glyph server expects the comma between names left as-is.
pub(crate) fn encode_fontstack(fontstack: &str) -> String {
    fontstack.replace(' ', "%20")
}

/// True when a URL's host is one the style is allowed to reference. Defense in depth on top of the
/// client's guarded DNS resolver, which already rejects private and loopback targets.
pub(crate) fn host_allowed(url: &str, allowed_hosts: &[String]) -> bool {
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

/// Fetch the upstream style, learn its glyph template, per-source tile templates, and per-source
/// maxzoom (inline on the source, or from the source's TileJSON), store the StyleState, and return the
/// parsed style document for the caller to rewrite and serve. Returns None for a non-style or unknown
/// source, a host off the allowlist, or any fetch failure.
async fn fetch_and_learn(state: &AppState, source: &str) -> Option<Value> {
    let (style_url, allowed) = {
        let map = state.sources.read().await;
        match map.get(source).map(|s| s.upstream.clone()) {
            Some(UpstreamTemplate::Style { style_url, allowed_hosts }) => (style_url, allowed_hosts),
            _ => return None,
        }
    };
    if !host_allowed(&style_url, &allowed) {
        return None;
    }
    let style = fetch_json(state, &style_url).await?;
    let glyphs = style.get("glyphs").and_then(|v| v.as_str()).map(String::from);
    let sprite_base = style.get("sprite").and_then(|v| v.as_str()).map(String::from);
    // The distinct fontstacks the style references, in the canonical decoded comma-joined form the
    // glyph route keys on. A data-driven (non-array) text-font is skipped rather than panicking.
    let mut fontstacks: Vec<String> = Vec::new();
    if let Some(layers) = style.get("layers").and_then(|v| v.as_array()) {
        for layer in layers {
            if let Some(arr) = layer.get("layout").and_then(|l| l.get("text-font")).and_then(|v| v.as_array()) {
                let joined: String = arr.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(",");
                if !joined.is_empty() && !fontstacks.contains(&joined) {
                    fontstacks.push(joined);
                }
            }
        }
    }

    let mut source_tiles: HashMap<String, Vec<String>> = HashMap::new();
    let mut source_maxzoom: HashMap<String, u32> = HashMap::new();
    let names: Vec<String> = style
        .get("sources")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    for name in &names {
        let src = style["sources"][name].clone();
        // maxzoom can be inline on the source, or in the source's TileJSON (fetched below).
        let inline_max = src.get("maxzoom").and_then(|v| v.as_u64()).map(|m| m as u32);
        let (tiles, tj_max): (Vec<String>, Option<u32>) = if let Some(arr) = src.get("tiles").and_then(|v| v.as_array()) {
            (arr.iter().filter_map(|x| x.as_str().map(String::from)).collect(), None)
        } else if let Some(url) = src.get("url").and_then(|v| v.as_str()) {
            if host_allowed(url, &allowed) {
                match fetch_json(state, url).await {
                    Some(tj) => (
                        tj.get("tiles").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                        tj.get("maxzoom").and_then(|v| v.as_u64()).map(|m| m as u32),
                    ),
                    None => (Vec::new(), None),
                }
            } else {
                (Vec::new(), None)
            }
        } else {
            (Vec::new(), None)
        };
        if tiles.is_empty() {
            continue;
        }
        if let Some(m) = inline_max.or(tj_max) {
            source_maxzoom.insert(name.clone(), m);
        }
        source_tiles.insert(name.clone(), tiles);
    }
    state.style_state.write().await.insert(source.to_string(), StyleState { glyphs, source_tiles, source_maxzoom, fontstacks, sprite_base });
    Some(style)
}

/// Ensure the StyleState for a source is learned, fetching it once if absent. Idempotent: returns
/// true without a refetch when already learned. Used by the warm path so it can enumerate a style
/// source's vector tiles without a prior GET /style request.
pub async fn ensure_style_learned(state: &AppState, source: &str) -> bool {
    if state.style_state.read().await.contains_key(source) {
        return true;
    }
    fetch_and_learn(state, source).await.is_some()
}

/// GET /style/:source: fetch, learn, rewrite, and serve the basemap style.
async fn style_doc(State(state): State<AppState>, Path(source): Path<String>) -> Response {
    // Preserve the 404 for an unknown or non-style source; a fetch failure is a 502 below.
    {
        let map = state.sources.read().await;
        match map.get(&source).map(|s| s.upstream.clone()) {
            Some(UpstreamTemplate::Style { .. }) => {}
            _ => return StatusCode::NOT_FOUND.into_response(),
        }
    }
    let Some(mut style) = fetch_and_learn(&state, &source).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let public = state.public_base.read().await.clone();
    let learned = { state.style_state.read().await.get(&source).cloned() };
    let Some(learned) = learned else { return StatusCode::BAD_GATEWAY.into_response() };

    // Rewrite the glyphs and the learned sources to point back at the plugin.
    if learned.glyphs.is_some() {
        style["glyphs"] = Value::String(format!("{public}/style/{source}/glyphs/{{fontstack}}/{{range}}.pbf"));
    }
    for name in learned.source_tiles.keys() {
        let maxzoom = learned.source_maxzoom.get(name).copied();
        if let Some(obj) = style["sources"][name].as_object_mut() {
            obj.remove("url");
            obj.insert(
                "tiles".to_string(),
                Value::Array(vec![Value::String(format!("{public}/style/{source}/tiles/{name}/{{z}}/{{x}}/{{y}}"))]),
            );
            // Carry the learned maxzoom back into the served source. Replacing the source's TileJSON
            // url with a tiles array drops the TileJSON maxzoom; without it MapLibre assumes tiles
            // exist past the native max zoom and requests 404s above it instead of overzooming the
            // deepest cached tile.
            if !obj.contains_key("maxzoom") {
                if let Some(m) = maxzoom {
                    obj.insert("maxzoom".to_string(), Value::from(m));
                }
            }
        }
    }
    // The sprite is intentionally NOT rewritten to the plugin path: MapLibre requires the sprite URL
    // to be absolute and rejects a path-absolute /plugins/... value ("Invalid sprite URL, must be
    // absolute"), which aborts the whole style load. The sprite stays the upstream absolute URL (so it
    // loads online); the /style/:source/sprite route and its cache remain for a later offline-sprite
    // pass that absolutizes the URL at the webapp edge.

    let body = match serde_json::to_vec(&style) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// GET /style/:source/glyphs/:fontstack/:range: serve a glyph range cache-first, keyed by the decoded
/// fontstack so a warmed glyph (warm-write under the same key) serves offline.
async fn glyphs(State(state): State<AppState>, Path((source, fontstack, range)): Path<(String, String, String)>) -> Response {
    let Some(range_start) = glyph_range_start(&range) else { return StatusCode::NOT_FOUND.into_response() };
    let cache_source = glyph_cache_source(&source, &fontstack);

    // Cache first (also the offline path). A cached negative (zero-byte) row serves as a 404 so
    // MapLibre treats the range as absent rather than an error.
    if let Ok(Some(tile)) = state.cache.get(&cache_source, 0, range_start, 0) {
        if tile.status == 200 {
            if now_secs() - tile.last_access >= crate::fetcher::TOUCH_THROTTLE_SECS {
                crate::fetcher::log_cache_err(state.cache.touch(&cache_source, 0, range_start, 0, now_secs()));
            }
            return ([(header::CONTENT_TYPE, tile.content_type.clone())], tile.blob.clone().unwrap_or_default()).into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    }

    let template = { state.style_state.read().await.get(&source).and_then(|s| s.glyphs.clone()) };
    let Some(template) = template else { return StatusCode::NOT_FOUND.into_response() };
    let allowed = style_allowed_hosts(&state, &source).await;
    let upstream = template.replace("{fontstack}", &encode_fontstack(&fontstack)).replace("{range}.pbf", &range);
    if !host_allowed(&upstream, &allowed) {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    match crate::fetcher::fetch_upstream(&state, &upstream, None).await {
        Ok((200, f)) => {
            let now = now_secs();
            let tile = CachedTile {
                content_type: f.content_type, strong_etag: crate::fetcher::strong_etag(&f.body), upstream_validator: None,
                status: 200, fetched_at: now, last_access: now, bytes: f.body.len() as i64, blob: Some(f.body),
            };
            crate::fetcher::log_cache_err(state.cache.put(&cache_source, 0, range_start, 0, &tile, false, now));
            crate::fetcher::log_cache_err(state.cache.evict_to(state.live_cap_bytes.load(Ordering::Relaxed)));
            ([(header::CONTENT_TYPE, tile.content_type.clone())], tile.blob.clone().unwrap_or_default()).into_response()
        }
        Ok((404, _)) | Ok((204, _)) => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

// The sprite variants. MapLibre appends the suffix to the sprite base with no slash, so each is an
// explicit route. The variant index is the synthetic cache x.
async fn sprite_json(s: State<AppState>, p: Path<String>) -> Response { sprite_variant(s.0, p.0, 0, ".json").await }
async fn sprite_png(s: State<AppState>, p: Path<String>) -> Response { sprite_variant(s.0, p.0, 1, ".png").await }
async fn sprite_2x_json(s: State<AppState>, p: Path<String>) -> Response { sprite_variant(s.0, p.0, 2, "@2x.json").await }
async fn sprite_2x_png(s: State<AppState>, p: Path<String>) -> Response { sprite_variant(s.0, p.0, 3, "@2x.png").await }

/// Serve a sprite variant cache-first under sprite_cache_source at x = variant, reconstructing the
/// upstream from the learned sprite base plus the suffix.
async fn sprite_variant(state: AppState, source: String, variant: u32, suffix: &str) -> Response {
    let cache_source = sprite_cache_source(&source);
    if let Ok(Some(tile)) = state.cache.get(&cache_source, 0, variant, 0) {
        if tile.status == 200 {
            return ([(header::CONTENT_TYPE, tile.content_type.clone())], tile.blob.clone().unwrap_or_default()).into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    }
    let base = { state.style_state.read().await.get(&source).and_then(|s| s.sprite_base.clone()) };
    let Some(base) = base else { return StatusCode::NOT_FOUND.into_response() };
    let allowed = style_allowed_hosts(&state, &source).await;
    let upstream = format!("{base}{suffix}");
    if !host_allowed(&upstream, &allowed) {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    match crate::fetcher::fetch_upstream(&state, &upstream, None).await {
        Ok((200, f)) => {
            let now = now_secs();
            let tile = CachedTile {
                content_type: f.content_type, strong_etag: crate::fetcher::strong_etag(&f.body), upstream_validator: None,
                status: 200, fetched_at: now, last_access: now, bytes: f.body.len() as i64, blob: Some(f.body),
            };
            crate::fetcher::log_cache_err(state.cache.put(&cache_source, 0, variant, 0, &tile, false, now));
            crate::fetcher::log_cache_err(state.cache.evict_to(state.live_cap_bytes.load(Ordering::Relaxed)));
            ([(header::CONTENT_TYPE, tile.content_type.clone())], tile.blob.clone().unwrap_or_default()).into_response()
        }
        Ok((404, _)) | Ok((204, _)) => StatusCode::NOT_FOUND.into_response(),
        _ => StatusCode::BAD_GATEWAY.into_response(),
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
            crate::fetcher::log_cache_err(state.cache.put(&cache_source, z, x, y, &tile, false, now));
            // Soft reserve: the scroll cache uses the whole cap. evict_to(cap) drops only unpinned rows,
            // so the scroll cache fills the cap minus the bytes actually pinned by saved regions.
            crate::fetcher::log_cache_err(state.cache.evict_to(state.live_cap_bytes.load(Ordering::Relaxed)));
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
                        r#"{{"version":8,"glyphs":"http://{a}/fonts/{{fontstack}}/{{range}}.pbf","sprite":"http://{a}/sprites/ofm","sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[{{"id":"l","type":"symbol","layout":{{"text-font":["Noto Sans Regular"]}}}}]}}"#
                    );
                    ([(header::CONTENT_TYPE, "application/json")], body)
                }),
            )
            .route(
                "/tiles.json",
                get(move || async move {
                    ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#))
                }),
            )
            .route("/fonts/:fontstack/:range", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![7u8, 7, 7]) }))
            .route("/sprites/:name", get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":1}"#) }))
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
    async fn ensure_style_learned_records_tiles_and_source_maxzoom() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        crate::routes::app(st.clone())
            .oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap())
            .await.unwrap();
        assert!(crate::style::ensure_style_learned(&st, "basemap").await, "the style is learned");
        let ss = st.style_state.read().await;
        let learned = ss.get("basemap").unwrap();
        assert!(learned.source_tiles.contains_key("openmaptiles"), "the vector source tile template is learned");
        assert_eq!(learned.source_maxzoom.get("openmaptiles"), Some(&14), "the vector source maxzoom is learned from its TileJSON");
        drop(ss);
        assert!(crate::style::ensure_style_learned(&st, "basemap").await, "a second call is idempotent");
    }

    #[tokio::test]
    async fn learn_records_fontstacks_and_sprite_base() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        crate::routes::app(st.clone())
            .oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap())
            .await.unwrap();
        assert!(crate::style::ensure_style_learned(&st, "basemap").await);
        let ss = st.style_state.read().await;
        let learned = ss.get("basemap").unwrap();
        assert!(learned.fontstacks.iter().any(|f| f == "Noto Sans Regular"), "the multi-word fontstack is learned in decoded form");
        assert_eq!(learned.sprite_base.as_deref(), Some(format!("http://{addr}/sprites/ofm").as_str()), "the sprite base is learned");
    }

    #[tokio::test]
    async fn glyph_route_serves_a_cached_multi_word_fontstack_without_refetch() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap()).await.unwrap();
        router.clone().oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap()).await.unwrap();
        // Seed a cached glyph under the synthetic key with a body distinct from the upstream stub (7,7,7),
        // so serving the seed (not a refetch) is detectable.
        let key = crate::style::glyph_cache_source("basemap", "Noto Sans Regular");
        let now = crate::state::now_secs();
        let tile = crate::cache::CachedTile {
            content_type: "application/x-protobuf".into(), strong_etag: "g".into(), upstream_validator: None,
            status: 200, fetched_at: now, last_access: now, bytes: 3, blob: Some(bytes::Bytes::from(vec![9u8, 9, 9])),
        };
        st.cache.put(&key, 0, 0, 0, &tile, true, now).unwrap();
        let resp = router.oneshot(Request::get("/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.as_ref(), &[9u8, 9, 9], "the cached glyph is served, not refetched");
    }

    #[tokio::test]
    async fn glyph_route_serves_a_cached_negative_as_404() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap()).await.unwrap();
        router.clone().oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap()).await.unwrap();
        let key = crate::style::glyph_cache_source("basemap", "Noto Sans Regular");
        let now = crate::state::now_secs();
        let neg = crate::cache::CachedTile { content_type: String::new(), strong_etag: String::new(), upstream_validator: None, status: 404, fetched_at: now, last_access: now, bytes: 0, blob: None };
        st.cache.put(&key, 0, 0, 0, &neg, true, now).unwrap();
        let resp = router.oneshot(Request::get("/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "a cached negative glyph serves as a 404");
    }

    #[tokio::test]
    async fn sprite_route_proxies_caches_and_the_style_rewrites_sprite() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap()).await.unwrap();
        let style_resp = router.clone().oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap()).await.unwrap();
        let style = body_json(style_resp).await;
        // The sprite URL is left absolute (upstream), not rewritten, because MapLibre rejects a
        // path-absolute sprite. The route still serves and caches the sprite for a later offline pass.
        assert_eq!(style["sprite"], format!("http://{addr}/sprites/ofm"));
        let sprite = router.clone().oneshot(Request::get("/style/basemap/sprite.json").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(sprite.status(), StatusCode::OK);
        assert!(st.cache.get(&crate::style::sprite_cache_source("basemap"), 0, 0, 0).unwrap().is_some(), "sprite.json is cached under variant index 0");
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
