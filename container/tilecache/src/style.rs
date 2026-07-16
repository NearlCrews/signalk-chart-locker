//! The vector basemap proxy. The container fetches the upstream style document, learns its glyph and
//! per-source vector-tile templates (fetching each source's TileJSON), rewrites the style so the glyphs
//! and tiles point back at the plugin, and serves the rewritten style. The glyph and tile sub-routes
//! reconstruct the upstream URL from the learned templates and fetch it, checked against the style's
//! allowed hosts and the client's guarded DNS resolver. Vector tiles, glyphs, and sprites share the
//! generation-aware cache so the basemap remains coherent across configuration changes.

use crate::cache::{CachedTile, TileKey};
use crate::source::UpstreamTemplate;
use crate::state::{now_secs, AppState, StyleState};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;

const MAX_STYLE_SOURCES: usize = 64;
const MAX_STYLE_LAYERS: usize = 2048;
const MAX_FONTSTACKS: usize = 64;
const MAX_TEMPLATES_PER_SOURCE: usize = 4;
const MAX_STYLE_URL_BYTES: usize = 4096;
const MAX_STYLE_SOURCE_NAME_BYTES: usize = 256;
/// Chart Locker currently exposes one vector basemap style. Bounding the configured and learned set
/// prevents persistent parsed style documents from scaling with the generic 128-source catalog limit.
pub(crate) const MAX_LEARNED_STYLE_ENTRIES: usize = 1;
/// A map style is metadata, not a tile. Keep its parsed persistent representation far below the tile
/// body cap while leaving ample room for the shipped OpenFreeMap style.
pub(crate) const MAX_STYLE_JSON_BYTES: usize = 1024 * 1024;
const MAX_TILEJSON_BYTES: usize = 256 * 1024;
const MAX_SPRITE_JSON_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StyleAssetKind {
    Glyph,
    SpriteJson,
    SpritePng,
    VectorTile,
}

pub(crate) fn valid_style_asset(kind: StyleAssetKind, content_type: &str, body: &[u8]) -> bool {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match kind {
        StyleAssetKind::Glyph | StyleAssetKind::VectorTile => matches!(
            media_type.as_str(),
            "application/x-protobuf" | "application/vnd.mapbox-vector-tile"
        ),
        StyleAssetKind::SpritePng => media_type == "image/png",
        StyleAssetKind::SpriteJson => {
            media_type == "application/json"
                && body.len() <= MAX_SPRITE_JSON_BYTES
                && serde_json::from_slice::<Value>(body)
                    .ok()
                    .is_some_and(|value| value.is_object())
        }
    }
}

pub fn style_routes() -> Router<AppState> {
    Router::new()
        .route("/style/{source}", get(style_doc))
        .route("/style/{source}/glyphs/{fontstack}/{range}", get(glyphs))
        .route("/style/{source}/sprite.json", get(sprite_json))
        .route("/style/{source}/sprite.png", get(sprite_png))
        .route("/style/{source}/sprite@2x.json", get(sprite_2x_json))
        .route("/style/{source}/sprite@2x.png", get(sprite_2x_png))
        .route("/style/{source}/tiles/{name}/{z}/{x}/{y}", get(vector_tile))
}

pub(crate) fn glyph_cache_source_at(
    style_source: &str,
    fontstack: &str,
    generation: u64,
) -> String {
    format!("style:{generation}:{style_source}:glyphs:{fontstack}")
}

pub(crate) fn sprite_cache_source_at(style_source: &str, generation: u64) -> String {
    format!("style:{generation}:{style_source}:sprite")
}

pub(crate) fn vector_cache_source_at(style_source: &str, name: &str, generation: u64) -> String {
    format!("style:{generation}:{style_source}:{name}")
}

/// The sprite variants MapLibre requests, as (cache-x index, upstream suffix) pairs, for the warm engine
/// to enumerate. Keep in sync with the four sprite serve routes (sprite_json, sprite_png, sprite_2x_json,
/// sprite_2x_png), which use the same fixed index and suffix per route.
pub(crate) const SPRITE_VARIANTS: [(u32, &str); 4] =
    [(0, ".json"), (1, ".png"), (2, "@2x.json"), (3, "@2x.png")];

/// Parse and canonicalize a glyph range param like `0-255.pbf`. Returns `(range_start, "start-end.pbf")`
/// only for a well-formed, 256-aligned, 256-wide range (the shape MapLibre requests). Returns None
/// otherwise. The caller keys the cache on `range_start` and substitutes the returned canonical string
/// into the upstream URL, never the raw param, so a crafted range can neither mis-key the cache (two
/// different malformed ends collide on the same start) nor smuggle an arbitrary path into the upstream.
pub(crate) fn glyph_range(range: &str) -> Option<(u32, String)> {
    let stem = range.strip_suffix(".pbf")?;
    let (start_s, end_s) = stem.split_once('-')?;
    let start: u32 = start_s.parse().ok()?;
    let end: u32 = end_s.parse().ok()?;
    if !start.is_multiple_of(256) || start > 0x10ff00 || end != start + 255 {
        return None;
    }
    Some((start, format!("{start}-{end}.pbf")))
}

/// Percent-encode a fontstack for an upstream glyph URL segment (the cache key uses the decoded form).
/// Spaces, commas, and every other non-alphanumeric byte are encoded.
pub(crate) fn encode_fontstack(fontstack: &str) -> String {
    percent_encoding::utf8_percent_encode(fontstack, percent_encoding::NON_ALPHANUMERIC).to_string()
}

pub(crate) fn expand_glyph_url(template: &str, fontstack: &str, canonical_range: &str) -> String {
    let range = canonical_range
        .strip_suffix(".pbf")
        .unwrap_or(canonical_range);
    template
        .replace("{fontstack}", &encode_fontstack(fontstack))
        .replace("{range}", range)
}

fn optional_maxzoom(value: Option<&Value>) -> Result<Option<u32>, ()> {
    match value {
        None => Ok(None),
        Some(value) => {
            let zoom = value.as_u64().ok_or(())?;
            let zoom = u32::try_from(zoom).map_err(|_| ())?;
            if zoom > 24 {
                return Err(());
            }
            Ok(Some(zoom))
        }
    }
}

fn tile_templates(value: Option<&Value>) -> Result<Option<Vec<String>>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let values = value.as_array().ok_or(())?;
    if values.is_empty() || values.len() > MAX_TEMPLATES_PER_SOURCE {
        return Err(());
    }
    values
        .iter()
        .map(|value| value.as_str().map(str::to_string).ok_or(()))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn valid_style_source_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_STYLE_SOURCE_NAME_BYTES
        && !name.chars().any(char::is_control)
}

pub(crate) fn style_url_allowed(url: &str, allowed_hosts: &[String], allow_http: bool) -> bool {
    reqwest::Url::parse(url).is_ok_and(|parsed| {
        (parsed.scheme() == "https" || (allow_http && parsed.scheme() == "http"))
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.as_str().len() <= MAX_STYLE_URL_BYTES
            && parsed.host_str().is_some_and(|host| {
                allowed_hosts
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(host))
            })
    })
}

async fn fetch_json(
    state: &AppState,
    url: &str,
    validator: Option<&str>,
    max_bytes: usize,
) -> Result<Option<(Value, Option<String>)>, ()> {
    let resp = state
        .guarded_get(url, validator, None)
        .await
        .map_err(|_| ())?;
    if resp.status() == StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(());
    }
    let validator = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(|value| format!("etag:{value}"))
        .or_else(|| {
            resp.headers()
                .get(reqwest::header::LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
                .map(|value| format!("last-modified:{value}"))
        });
    let body = state.read_capped_to(resp, max_bytes).await.ok_or(())?;
    let value = serde_json::from_slice::<Value>(&body).map_err(|_| ())?;
    Ok(Some((value, validator)))
}

/// Fetch the upstream style, learn its glyph template, per-source tile templates, and per-source
/// maxzoom (inline on the source, or from the source's TileJSON), store the StyleState, and return the
/// parsed style document for the caller to rewrite and serve. Returns None for a non-style or unknown
/// source, a host off the allowlist, or any fetch failure.
async fn fetch_and_learn(state: &AppState, source: &str) -> Option<Arc<Value>> {
    let generation = state.config_generation.load(Ordering::Acquire);
    if !generation.is_multiple_of(2) {
        return None;
    }
    if let Some(existing) = state.style_state.read().await.get(source).cloned() {
        if existing.generation == generation
            && now_secs() - existing.fetched_at < state.knobs.fresh_secs
        {
            return Some(existing.document.clone());
        }
    }
    let flight_key = format!("style-learn:{generation}:{source}");
    let flight = state.inflight_lock(&flight_key).await?;
    let _guard = flight.lock().await;
    if let Some(existing) = state.style_state.read().await.get(source).cloned() {
        if existing.generation == generation
            && now_secs() - existing.fetched_at < state.knobs.fresh_secs
        {
            state.inflight_finish(&flight_key, &flight).await;
            return Some(existing.document.clone());
        }
    }
    let (style_url, allowed) = {
        let map = state.sources.read().await;
        match map.get(source).map(|s| s.upstream.clone()) {
            Some(UpstreamTemplate::Style {
                style_url,
                allowed_hosts,
            }) => (style_url, allowed_hosts),
            _ => {
                state.inflight_finish(&flight_key, &flight).await;
                return None;
            }
        }
    };
    if !style_url_allowed(&style_url, &allowed, state.knobs.allow_private_egress) {
        state.inflight_finish(&flight_key, &flight).await;
        return None;
    }
    let existing = state.style_state.read().await.get(source).cloned();
    let fetched = fetch_json(
        state,
        &style_url,
        existing
            .as_ref()
            .filter(|entry| entry.generation == generation)
            .and_then(|entry| entry.upstream_validator.as_deref()),
        MAX_STYLE_JSON_BYTES,
    )
    .await;
    let (style, upstream_validator) = match fetched {
        Ok(Some(fetched)) => fetched,
        Ok(None) => {
            let mut styles = state.style_state.write().await;
            let Some(existing) = styles.get(source).cloned() else {
                drop(styles);
                state.inflight_finish(&flight_key, &flight).await;
                return None;
            };
            if existing.generation != generation {
                drop(styles);
                state.inflight_finish(&flight_key, &flight).await;
                return None;
            }
            let mut refreshed = (*existing).clone();
            refreshed.fetched_at = now_secs();
            let document = existing.document.clone();
            styles.insert(source.to_string(), Arc::new(refreshed));
            drop(styles);
            state.inflight_finish(&flight_key, &flight).await;
            return Some(document);
        }
        Err(()) => {
            let stale = existing.filter(|entry| {
                entry.generation == generation
                    && now_secs() - entry.fetched_at < state.knobs.max_stale_secs
            });
            state.inflight_finish(&flight_key, &flight).await;
            return stale.map(|entry| entry.document.clone());
        }
    };
    let style = Arc::new(style);
    let Some(layers) = style.get("layers").and_then(Value::as_array) else {
        state.inflight_finish(&flight_key, &flight).await;
        return None;
    };
    let Some(source_object) = style.get("sources").and_then(Value::as_object) else {
        state.inflight_finish(&flight_key, &flight).await;
        return None;
    };
    if layers.len() > MAX_STYLE_LAYERS
        || source_object.is_empty()
        || source_object.len() > MAX_STYLE_SOURCES
    {
        state.inflight_finish(&flight_key, &flight).await;
        return None;
    }
    let glyphs = style
        .get("glyphs")
        .and_then(|v| v.as_str())
        .map(String::from);
    let sprite_base = style
        .get("sprite")
        .and_then(|v| v.as_str())
        .map(String::from);
    if glyphs.as_ref().is_some_and(|url| {
        !style_url_allowed(url, &allowed, state.knobs.allow_private_egress)
            || !url.contains("{fontstack}")
            || !url.contains("{range}")
    }) || sprite_base
        .as_ref()
        .is_some_and(|url| !style_url_allowed(url, &allowed, state.knobs.allow_private_egress))
    {
        state.inflight_finish(&flight_key, &flight).await;
        return None;
    }
    // The distinct fontstacks the style references, in the canonical decoded comma-joined form the
    // glyph route keys on. A data-driven (non-array) text-font is skipped rather than panicking.
    let mut fontstacks: Vec<String> = Vec::new();
    let mut fontstack_set = HashSet::new();
    {
        for layer in layers {
            if let Some(arr) = layer
                .get("layout")
                .and_then(|l| l.get("text-font"))
                .and_then(|v| v.as_array())
            {
                let joined: String = arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .collect::<Vec<_>>()
                    .join(",");
                if !joined.is_empty() && joined.len() <= 512 && fontstack_set.insert(joined.clone())
                {
                    fontstacks.push(joined);
                    if fontstacks.len() > MAX_FONTSTACKS {
                        state.inflight_finish(&flight_key, &flight).await;
                        return None;
                    }
                }
            }
        }
    }

    let mut source_tiles: HashMap<String, Vec<String>> = HashMap::new();
    let mut source_maxzoom: HashMap<String, u32> = HashMap::new();
    let names: Vec<String> = source_object.keys().cloned().collect();
    for name in &names {
        if !valid_style_source_name(name) {
            state.inflight_finish(&flight_key, &flight).await;
            return None;
        }
        let src = &style["sources"][name];
        let declared_tile_source = src.get("tiles").is_some() || src.get("url").is_some();
        // maxzoom can be inline on the source, or in the source's TileJSON (fetched below).
        let inline_max = match optional_maxzoom(src.get("maxzoom")) {
            Ok(value) => value,
            Err(()) => {
                state.inflight_finish(&flight_key, &flight).await;
                return None;
            }
        };
        let (tiles, tj_max): (Vec<String>, Option<u32>) =
            if let Ok(Some(tiles)) = tile_templates(src.get("tiles")) {
                // Reject the whole style when any inline template is unusable, so an apparently
                // successful style response never contains a source that only fails later at serve time.
                if tiles.iter().any(|template| {
                    !style_url_allowed(template, &allowed, state.knobs.allow_private_egress)
                        || !["{z}", "{x}", "{y}"]
                            .iter()
                            .all(|token| template.contains(token))
                }) {
                    state.inflight_finish(&flight_key, &flight).await;
                    return None;
                }
                (tiles, None)
            } else if src.get("tiles").is_some() {
                state.inflight_finish(&flight_key, &flight).await;
                return None;
            } else if let Some(url) = src.get("url").and_then(|v| v.as_str()) {
                if style_url_allowed(url, &allowed, state.knobs.allow_private_egress) {
                    match fetch_json(state, url, None, MAX_TILEJSON_BYTES).await {
                        Ok(Some((tj, _))) => {
                            let tiles = match tile_templates(tj.get("tiles")) {
                                Ok(Some(tiles)) => tiles,
                                _ => {
                                    state.inflight_finish(&flight_key, &flight).await;
                                    return None;
                                }
                            };
                            let maxzoom = match optional_maxzoom(tj.get("maxzoom")) {
                                Ok(value) => value,
                                Err(()) => {
                                    state.inflight_finish(&flight_key, &flight).await;
                                    return None;
                                }
                            };
                            (tiles, maxzoom)
                        }
                        _ => {
                            state.inflight_finish(&flight_key, &flight).await;
                            return None;
                        }
                    }
                } else {
                    state.inflight_finish(&flight_key, &flight).await;
                    return None;
                }
            } else {
                (Vec::new(), None)
            };
        if tiles.is_empty() {
            if declared_tile_source {
                state.inflight_finish(&flight_key, &flight).await;
                return None;
            }
            continue;
        }
        if tiles.len() > MAX_TEMPLATES_PER_SOURCE
            || tiles.iter().any(|template| {
                !style_url_allowed(template, &allowed, state.knobs.allow_private_egress)
                    || !["{z}", "{x}", "{y}"]
                        .iter()
                        .all(|token| template.contains(token))
            })
        {
            state.inflight_finish(&flight_key, &flight).await;
            return None;
        }
        if let Some(m) = inline_max.or(tj_max) {
            source_maxzoom.insert(name.clone(), m);
        }
        source_tiles.insert(name.clone(), tiles);
    }
    if source_tiles.is_empty() || state.config_generation.load(Ordering::Acquire) != generation {
        state.inflight_finish(&flight_key, &flight).await;
        return None;
    }
    let mut styles = state.style_state.write().await;
    if !styles.contains_key(source) && styles.len() >= MAX_LEARNED_STYLE_ENTRIES {
        drop(styles);
        state.inflight_finish(&flight_key, &flight).await;
        return None;
    }
    styles.insert(
        source.to_string(),
        Arc::new(StyleState {
            glyphs,
            source_tiles,
            source_maxzoom,
            fontstacks,
            sprite_base,
            generation,
            document: style.clone(),
            fetched_at: now_secs(),
            upstream_validator,
        }),
    );
    drop(styles);
    state.inflight_finish(&flight_key, &flight).await;
    Some(style)
}

/// Ensure the StyleState for a source is learned, fetching it once if absent. Idempotent: returns
/// true without a refetch when already learned. Used by the warm path so it can enumerate a style
/// source's vector tiles without a prior GET /style request.
pub async fn ensure_style_learned(state: &AppState, source: &str) -> bool {
    let generation = state.config_generation.load(Ordering::Acquire);
    if state
        .style_state
        .read()
        .await
        .get(source)
        .is_some_and(|style| {
            style.generation == generation && now_secs() - style.fetched_at < state.knobs.fresh_secs
        })
    {
        return true;
    }
    fetch_and_learn(state, source).await.is_some()
}

/// GET /style/:source: fetch, learn, rewrite, and serve the basemap style.
async fn style_doc(
    State(state): State<AppState>,
    Path(source): Path<String>,
    headers: HeaderMap,
) -> Response {
    // Preserve the 404 for an unknown or non-style source; a fetch failure is a 502 below.
    {
        let map = state.sources.read().await;
        match map.get(&source).map(|s| s.upstream.clone()) {
            Some(UpstreamTemplate::Style { .. }) => {}
            _ => return StatusCode::NOT_FOUND.into_response(),
        }
    }
    let Some(style) = fetch_and_learn(&state, &source).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let mut style = (*style).clone();
    let public = state.public_base.read().await.clone();
    let learned = { state.style_state.read().await.get(&source).cloned() };
    let Some(learned) = learned else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let stale = now_secs() - learned.fetched_at >= state.knobs.fresh_secs;

    // Rewrite the glyphs and the learned sources to point back at the plugin.
    if learned.glyphs.is_some() {
        style["glyphs"] = Value::String(format!(
            "{public}/style/{source}/glyphs/{{fontstack}}/{{range}}.pbf"
        ));
    }
    for name in learned.source_tiles.keys() {
        let encoded_name =
            percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
        let maxzoom = learned.source_maxzoom.get(name).copied();
        if let Some(obj) = style["sources"][name].as_object_mut() {
            obj.remove("url");
            obj.insert(
                "tiles".to_string(),
                Value::Array(vec![Value::String(format!(
                    "{public}/style/{source}/tiles/{encoded_name}/{{z}}/{{x}}/{{y}}"
                ))]),
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
    // Rust leaves the sprite unchanged because MapLibre rejects a path-absolute /plugins/... value.
    // The Node proxy has the request origin and replaces it with the fully absolute plugin sprite route,
    // so MapLibre uses the cached container route online and offline.

    let body = match serde_json::to_vec(&style) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let etag = crate::fetcher::strong_etag(&body);
    crate::response::tile_http_response(
        "application/json",
        &etag,
        stale,
        body.into(),
        headers
            .get(header::IF_NONE_MATCH)
            .and_then(|value| value.to_str().ok()),
    )
}

/// GET /style/:source/glyphs/:fontstack/:range: serve a glyph range cache-first, keyed by the decoded
/// fontstack so a warmed glyph (warm-write under the same key) serves offline.
async fn glyphs(
    State(state): State<AppState>,
    Path((source, fontstack, range)): Path<(String, String, String)>,
) -> Response {
    let Some((range_start, canonical_range)) = glyph_range(&range) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !ensure_style_learned(&state, &source).await {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let learned = state.style_state.read().await.get(&source).cloned();
    let Some(learned) = learned else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !learned.fontstacks.iter().any(|known| known == &fontstack) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let cache_source = glyph_cache_source_at(&source, &fontstack, learned.generation);
    // A cached negative glyph row always serves as a 404 so MapLibre treats the range as
    // absent rather than an error; a 200 is served offline-first.
    let serve_cached = |tile: &CachedTile| -> Option<Response> {
        if tile.status == 200
            && valid_style_asset(
                StyleAssetKind::Glyph,
                &tile.content_type,
                tile.blob.as_deref().unwrap_or_default(),
            )
            && now_secs() - tile.fetched_at < state.knobs.fresh_secs
        {
            if now_secs() - tile.last_access >= crate::fetcher::TOUCH_THROTTLE_SECS {
                touch_detached(&state, &cache_source, 0, range_start, 0, now_secs());
            }
            Some(raw_asset_response(tile))
        } else if tile.status != 200 && now_secs() - tile.fetched_at < state.knobs.negative_ttl_secs
        {
            Some(StatusCode::NOT_FOUND.into_response())
        } else {
            None
        }
    };
    cache_first_single_flight(
        &state,
        &cache_source,
        0,
        range_start,
        0,
        serve_cached,
        || async {
            let template = learned.glyphs.clone();
            let Some(template) = template else {
                return StatusCode::NOT_FOUND.into_response();
            };
            let allowed = style_allowed_hosts(&state, &source).await;
            let upstream = expand_glyph_url(&template, &fontstack, &canonical_range);
            if !style_url_allowed(&upstream, &allowed, state.knobs.allow_private_egress) {
                return StatusCode::BAD_GATEWAY.into_response();
            }
            fetch_asset_response(
                &state,
                AssetFetchKey {
                    health_source: &source,
                    cache_source: &cache_source,
                    z: 0,
                    x: range_start,
                    y: 0,
                    kind: StyleAssetKind::Glyph,
                },
                &upstream,
                None,
            )
            .await
        },
    )
    .await
}

/// A raw (content-type plus body, no ETag or Range) response for a cached glyph or sprite asset.
fn raw_asset_response(tile: &CachedTile) -> Response {
    crate::response::tile_http_response(
        &tile.content_type,
        &tile.strong_etag,
        false,
        tile.blob.clone().unwrap_or_default(),
        None,
    )
}

fn touch_detached(state: &AppState, source: &str, z: u32, x: u32, y: u32, now: i64) {
    let Some(permit) = state.try_touch_permit() else {
        return;
    };
    let cache = state.cache.clone();
    let source = source.to_string();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::fetcher::log_cache_err(
            &cache,
            "cache_touch_failed",
            cache.touch(TileKey::new(&source, z, x, y), now),
        );
    });
}

/// Build a 200 CachedTile for a fetched glyph or sprite asset.
fn new_asset_tile(f: crate::fetcher::Fetched, now: i64) -> CachedTile {
    CachedTile {
        content_type: f.content_type,
        strong_etag: crate::fetcher::strong_etag(&f.body),
        upstream_validator: f.validator,
        status: 200,
        fetched_at: now,
        last_access: now,
        bytes: f.body.len() as i64,
        blob: Some(f.body),
    }
}

struct AssetFetchKey<'a> {
    health_source: &'a str,
    cache_source: &'a str,
    z: u32,
    x: u32,
    y: u32,
    kind: StyleAssetKind,
}

async fn fetch_asset_response(
    state: &AppState,
    key: AssetFetchKey<'_>,
    upstream: &str,
    if_none_match: Option<&str>,
) -> Response {
    let AssetFetchKey {
        health_source,
        cache_source,
        z,
        x,
        y,
        kind,
    } = key;
    let stale = state.cache_get(cache_source, z, x, y).await.ok().flatten();
    let valid_stale = stale.filter(|tile| {
        tile.status == 200
            && valid_style_asset(
                kind,
                &tile.content_type,
                tile.blob.as_deref().unwrap_or_default(),
            )
    });
    let validator = valid_stale
        .as_ref()
        .and_then(|tile| tile.upstream_validator.as_deref());
    match crate::fetcher::fetch_upstream(state, health_source, upstream, validator).await {
        Ok((304, _)) => {
            let Some(mut tile) = valid_stale else {
                return StatusCode::BAD_GATEWAY.into_response();
            };
            let now = now_secs();
            tile.fetched_at = now;
            tile.last_access = now;
            let response = tile_response(&tile, if_none_match);
            store_and_evict(state, cache_source, z, x, y, tile, now).await;
            response
        }
        Ok((200, fetched)) => {
            if !valid_style_asset(kind, &fetched.content_type, &fetched.body) {
                return StatusCode::BAD_GATEWAY.into_response();
            }
            let now = now_secs();
            let tile = new_asset_tile(fetched, now);
            let response = tile_response(&tile, if_none_match);
            store_and_evict(state, cache_source, z, x, y, tile, now).await;
            response
        }
        Ok((404 | 204, _)) => {
            let now = now_secs();
            store_and_evict(
                state,
                cache_source,
                z,
                x,
                y,
                CachedTile::negative(404, now),
                now,
            )
            .await;
            StatusCode::NOT_FOUND.into_response()
        }
        _ => valid_stale
            .filter(|tile| now_secs() - tile.fetched_at < state.knobs.max_stale_secs)
            .map(|tile| {
                crate::response::tile_http_response(
                    &tile.content_type,
                    &tile.strong_etag,
                    true,
                    tile.blob.unwrap_or_default(),
                    if_none_match,
                )
            })
            .unwrap_or_else(|| StatusCode::BAD_GATEWAY.into_response()),
    }
}

// The sprite variants. MapLibre appends the suffix to the sprite base with no slash, so each is an
// explicit route. The variant index is the synthetic cache x.
async fn sprite_json(s: State<AppState>, p: Path<String>) -> Response {
    sprite_variant(s.0, p.0, 0, ".json").await
}
async fn sprite_png(s: State<AppState>, p: Path<String>) -> Response {
    sprite_variant(s.0, p.0, 1, ".png").await
}
async fn sprite_2x_json(s: State<AppState>, p: Path<String>) -> Response {
    sprite_variant(s.0, p.0, 2, "@2x.json").await
}
async fn sprite_2x_png(s: State<AppState>, p: Path<String>) -> Response {
    sprite_variant(s.0, p.0, 3, "@2x.png").await
}

/// Serve a sprite variant cache-first under sprite_cache_source at x = variant, reconstructing the
/// upstream from the learned sprite base plus the suffix.
async fn sprite_variant(state: AppState, source: String, variant: u32, suffix: &str) -> Response {
    if !ensure_style_learned(&state, &source).await {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let learned = state.style_state.read().await.get(&source).cloned();
    let Some(learned) = learned else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cache_source = sprite_cache_source_at(&source, learned.generation);
    let suffix = suffix.to_string();
    let kind = if suffix.ends_with(".json") {
        StyleAssetKind::SpriteJson
    } else {
        StyleAssetKind::SpritePng
    };
    // A cached sprite negative serves as a 404; a 200 is served offline-first (no last_access touch,
    // matching the prior behavior).
    let serve_cached = |tile: &CachedTile| -> Option<Response> {
        if tile.status == 200
            && valid_style_asset(
                kind,
                &tile.content_type,
                tile.blob.as_deref().unwrap_or_default(),
            )
            && now_secs() - tile.fetched_at < state.knobs.fresh_secs
        {
            Some(raw_asset_response(tile))
        } else if tile.status != 200 && now_secs() - tile.fetched_at < state.knobs.negative_ttl_secs
        {
            Some(StatusCode::NOT_FOUND.into_response())
        } else {
            None
        }
    };
    cache_first_single_flight(
        &state,
        &cache_source,
        0,
        variant,
        0,
        serve_cached,
        || async {
            let base = learned.sprite_base.clone();
            let Some(base) = base else {
                return StatusCode::NOT_FOUND.into_response();
            };
            let allowed = style_allowed_hosts(&state, &source).await;
            let upstream = format!("{base}{suffix}");
            if !style_url_allowed(&upstream, &allowed, state.knobs.allow_private_egress) {
                return StatusCode::BAD_GATEWAY.into_response();
            }
            fetch_asset_response(
                &state,
                AssetFetchKey {
                    health_source: &source,
                    cache_source: &cache_source,
                    z: 0,
                    x: variant,
                    y: 0,
                    kind,
                },
                &upstream,
                None,
            )
            .await
        },
    )
    .await
}

/// GET /style/:source/tiles/:name/:z/:x/:y: serve a basemap vector tile, cached through the tile cache.
async fn vector_tile(
    State(state): State<AppState>,
    Path((source, name, z, x, y)): Path<(String, String, u32, u32, u32)>,
    headers: HeaderMap,
) -> Response {
    if !ensure_style_learned(&state, &source).await {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let learned = state.style_state.read().await.get(&source).cloned();
    let Some(learned) = learned else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(template) = learned
        .source_tiles
        .get(&name)
        .and_then(|templates| templates.first())
        .cloned()
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let maxzoom = learned.source_maxzoom.get(&name).copied().unwrap_or(24);
    let dimension = 1u64.checked_shl(z).unwrap_or(0);
    if z > maxzoom || z > 24 || u64::from(x) >= dimension || u64::from(y) >= dimension {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let cache_source = vector_cache_source_at(&source, &name, learned.generation);
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    // Cache-first serves a 200 (last_access touch-throttled), serves a cached negative within the
    // negative TTL as a 404 (a warm-pinned 404 or 204), and otherwise falls through to a refetch so an
    // expired negative refetches.
    let serve_cached = |tile: &CachedTile| -> Option<Response> {
        if tile.status == 200
            && valid_style_asset(
                StyleAssetKind::VectorTile,
                &tile.content_type,
                tile.blob.as_deref().unwrap_or_default(),
            )
            && now_secs() - tile.fetched_at < state.knobs.fresh_secs
        {
            if now_secs() - tile.last_access >= crate::fetcher::TOUCH_THROTTLE_SECS {
                touch_detached(&state, &cache_source, z, x, y, now_secs());
            }
            Some(tile_response(tile, if_none_match.as_deref()))
        } else if now_secs() - tile.fetched_at < state.knobs.negative_ttl_secs {
            Some(StatusCode::NOT_FOUND.into_response())
        } else {
            None
        }
    };
    cache_first_single_flight(&state, &cache_source, z, x, y, serve_cached, || async {
        let allowed = style_allowed_hosts(&state, &source).await;
        let upstream = template
            .replace("{z}", &z.to_string())
            .replace("{x}", &x.to_string())
            .replace("{y}", &y.to_string());
        if !style_url_allowed(&upstream, &allowed, state.knobs.allow_private_egress) {
            return StatusCode::BAD_GATEWAY.into_response();
        }
        fetch_asset_response(
            &state,
            AssetFetchKey {
                health_source: &source,
                cache_source: &cache_source,
                z,
                x,
                y,
                kind: StyleAssetKind::VectorTile,
            },
            &upstream,
            if_none_match.as_deref(),
        )
        .await
    })
    .await
}

async fn style_allowed_hosts(state: &AppState, source: &str) -> Vec<String> {
    match state
        .sources
        .read()
        .await
        .get(source)
        .map(|s| s.upstream.clone())
    {
        Some(UpstreamTemplate::Style { allowed_hosts, .. }) => allowed_hosts,
        _ => Vec::new(),
    }
}

fn tile_response(tile: &CachedTile, if_none_match: Option<&str>) -> Response {
    crate::response::tile_http_response(
        &tile.content_type,
        &tile.strong_etag,
        false,
        tile.blob.clone().unwrap_or_default(),
        if_none_match,
    )
}

/// Store a fetched style sub-resource (glyph, sprite, or vector tile) and evict to the cap on the
/// blocking pool, so the window-function eviction scan never runs on the async reactor. Mirrors
/// the raster store path in `fetcher::store_200`.
async fn store_and_evict(
    state: &AppState,
    cache_source: &str,
    z: u32,
    x: u32,
    y: u32,
    tile: CachedTile,
    now: i64,
) {
    let cache = state.cache.clone();
    let cap = state.live_cap_bytes.load(Ordering::Relaxed);
    let cache_source = cache_source.to_string();
    if let Err(e) = tokio::task::spawn_blocking(move || {
        crate::fetcher::log_cache_err(
            &cache,
            "cache_write_failed",
            cache.put(TileKey::new(&cache_source, z, x, y), &tile, false, now),
        );
        crate::fetcher::log_cache_err(&cache, "cache_eviction_failed", cache.evict_to(cap));
    })
    .await
    {
        eprintln!("tilecache: style sub-resource store task failed: {e}");
    }
}

/// The cache-first plus single-flight scaffold shared by the glyph, sprite, and vector-tile routes.
/// `serve_cached` decides whether a cached row is servable now (returning Some, encapsulating each
/// route's 200-serve and its own negative-cache policy) or should fall through to a fetch (None).
/// `fetch_store` runs the upstream fetch, stores the result, and builds the response; it runs at most
/// once, under the single-flight lock. inflight_finish is guaranteed on every return path.
async fn cache_first_single_flight<S, F, Fut>(
    state: &AppState,
    cache_source: &str,
    z: u32,
    x: u32,
    y: u32,
    serve_cached: S,
    fetch_store: F,
) -> Response
where
    S: Fn(&CachedTile) -> Option<Response>,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Response>,
{
    if let Ok(Some(tile)) = state.cache_get(cache_source, z, x, y).await {
        if let Some(resp) = serve_cached(&tile) {
            return resp;
        }
    }
    // Single-flight the miss so a first-load burst of identical requests makes one upstream fetch.
    let key = format!("{cache_source}/{z}/{x}/{y}");
    let Some(lock) = state.inflight_lock(&key).await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let _guard = lock.lock().await;
    // Re-check: a concurrent flight or a warm may have filled the cache while we waited.
    if let Ok(Some(tile)) = state.cache_get(cache_source, z, x, y).await {
        if let Some(resp) = serve_cached(&tile) {
            state.inflight_finish(&key, &lock).await;
            return resp;
        }
    }
    let resp = fetch_store().await;
    state.inflight_finish(&key, &lock).await;
    resp
}

#[cfg(test)]
mod tests {
    use super::{
        glyph_cache_source_at, sprite_cache_source_at, valid_style_asset, vector_cache_source_at,
        StyleAssetKind,
    };
    use crate::cache::{TileCache, TileKey};
    use crate::routes::app;
    use crate::state::{AppState, Knobs};
    use axum::body::Body;
    use axum::extract::Path;
    use axum::http::{header, Request as HttpRequest, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::Router;
    use http_body_util::BodyExt;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::NamedTempFile;
    use tokio::net::TcpListener;
    use tower::ServiceExt;

    const TEST_CONTROL_TOKEN: &str = "test-control-token";

    struct Request;

    impl Request {
        fn get(uri: impl AsRef<str>) -> axum::http::request::Builder {
            HttpRequest::get(uri.as_ref())
        }

        fn post(uri: impl AsRef<str>) -> axum::http::request::Builder {
            HttpRequest::post(uri.as_ref())
                .header(crate::routes::CONTROL_TOKEN_HEADER, TEST_CONTROL_TOKEN)
        }
    }

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
            .route("/fonts/{fontstack}/{range}", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![7u8, 7, 7]) }))
            .route(
                "/sprites/{name}",
                get(|Path(name): Path<String>| async move {
                    if name.ends_with(".png") {
                        ([(header::CONTENT_TYPE, "image/png")], vec![137, 80, 78, 71])
                            .into_response()
                    } else {
                        (
                            [(header::CONTENT_TYPE, "application/json")],
                            r#"{"ok":1}"#,
                        )
                            .into_response()
                    }
                }),
            )
            .route("/t/{z}/{x}/{y}", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![8u8, 8, 8, 8]) }));
        tokio::spawn(async move {
            axum::serve(listener, stub).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    async fn spawn_unsafe_asset_upstream() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let a = addr;
        let stub = Router::new()
            .route(
                "/style",
                get(move || async move {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        format!(
                            r#"{{"version":8,"glyphs":"http://{a}/fonts/{{fontstack}}/{{range}}.pbf","sprite":"http://{a}/sprites/ofm","sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[{{"id":"l","type":"symbol","layout":{{"text-font":["Noto Sans Regular"]}}}}]}}"#
                        ),
                    )
                }),
            )
            .route(
                "/tiles.json",
                get(move || async move {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        format!(
                            r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#
                        ),
                    )
                }),
            )
            .route(
                "/fonts/{fontstack}/{range}",
                get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<script></script>") }),
            )
            .route(
                "/sprites/{name}",
                get(|Path(name): Path<String>| async move {
                    if name.ends_with(".png") {
                        ([(header::CONTENT_TYPE, "image/svg+xml")], "<svg/>").into_response()
                    } else {
                        ([(header::CONTENT_TYPE, "application/json")], "{malformed")
                            .into_response()
                    }
                }),
            )
            .route(
                "/t/{z}/{x}/{y}",
                get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<script></script>") }),
            );
        tokio::spawn(async move {
            axum::serve(listener, stub).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn dev_state(db: &NamedTempFile) -> AppState {
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let mut state = AppState::new(
            cache,
            Knobs {
                allow_private_egress: true,
                ..Default::default()
            },
        );
        state.control_token = Some(Arc::from(TEST_CONTROL_TOKEN));
        state
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

    #[test]
    fn glyph_substitution_supports_range_tokens_in_any_template_position() {
        assert_eq!(
            super::expand_glyph_url(
                "https://fonts.example/{fontstack}/glyph-{range}?format=pbf",
                "Noto Sans Regular,Marine Symbols",
                "256-511.pbf",
            ),
            "https://fonts.example/Noto%20Sans%20Regular%2CMarine%20Symbols/glyph-256-511?format=pbf",
        );
    }

    #[test]
    fn style_asset_validation_rejects_active_types_and_malformed_sprite_json() {
        assert!(valid_style_asset(
            StyleAssetKind::Glyph,
            "application/x-protobuf; charset=binary",
            &[1, 2, 3],
        ));
        assert!(valid_style_asset(
            StyleAssetKind::VectorTile,
            "application/vnd.mapbox-vector-tile",
            &[1, 2, 3],
        ));
        assert!(valid_style_asset(
            StyleAssetKind::SpritePng,
            "image/png",
            &[137, 80, 78, 71],
        ));
        assert!(valid_style_asset(
            StyleAssetKind::SpriteJson,
            "application/json; charset=utf-8",
            br#"{"icon":{"width":1}}"#,
        ));
        for (kind, content_type, body) in [
            (StyleAssetKind::Glyph, "text/html", b"<script/>".as_slice()),
            (
                StyleAssetKind::VectorTile,
                "image/svg+xml",
                b"<svg><script/></svg>".as_slice(),
            ),
            (
                StyleAssetKind::SpritePng,
                "image/svg+xml",
                b"<svg/>".as_slice(),
            ),
            (
                StyleAssetKind::SpriteJson,
                "application/json",
                b"{malformed".as_slice(),
            ),
            (
                StyleAssetKind::SpriteJson,
                "text/html",
                b"<script/>".as_slice(),
            ),
        ] {
            assert!(!valid_style_asset(kind, content_type, body));
        }
    }

    #[test]
    fn style_metadata_validation_rejects_absurd_zoom_mixed_tiles_and_names() {
        assert_eq!(
            super::optional_maxzoom(Some(&serde_json::json!(24))),
            Ok(Some(24))
        );
        assert!(super::optional_maxzoom(Some(&serde_json::json!(25))).is_err());
        assert!(super::optional_maxzoom(Some(&serde_json::json!(u64::MAX))).is_err());
        assert!(super::tile_templates(Some(&serde_json::json!([
            "https://tiles.example/{z}/{x}/{y}",
            7
        ])))
        .is_err());
        assert!(super::valid_style_source_name("openmaptiles"));
        assert!(!super::valid_style_source_name("bad\nname"));
        assert!(!super::valid_style_source_name(
            &"x".repeat(super::MAX_STYLE_SOURCE_NAME_BYTES + 1,)
        ));
    }

    #[tokio::test]
    async fn one_invalid_tilejson_rejects_the_entire_multi_source_style() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let upstream = Router::new()
            .route(
                "/style",
                get(move || async move {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        format!(
                            r#"{{"version":8,"sources":{{"good":{{"type":"vector","url":"http://{addr}/good.json"}},"bad":{{"type":"vector","url":"http://{addr}/bad.json"}}}},"layers":[]}}"#,
                        ),
                    )
                }),
            )
            .route(
                "/good.json",
                get(move || async move {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        format!(r#"{{"tiles":["http://{addr}/good/{{z}}/{{x}}/{{y}}"]}}"#),
                    )
                }),
            )
            .route(
                "/bad.json",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        r#"{"tiles":["https://example.invalid/{z}/{x}/{y}",7]}"#,
                    )
                }),
            );
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        let configured = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(configured.status(), StatusCode::NO_CONTENT);
        let response = router
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(
            !state.style_state.read().await.contains_key("basemap"),
            "no partial learned state is committed",
        );
    }

    #[tokio::test]
    async fn style_json_over_the_persistent_cap_is_rejected_without_learned_state() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let padding = "x".repeat(super::MAX_STYLE_JSON_BYTES);
        let upstream = Router::new().route(
            "/style",
            get(move || {
                let padding = padding.clone();
                async move {
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        format!(
                            r#"{{"version":8,"sources":{{"map":{{"type":"vector","tiles":["http://{addr}/t/{{z}}/{{x}}/{{y}}"]}}}},"layers":[],"padding":"{padding}"}}"#
                        ),
                    )
                }
            }),
        );
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        let configured = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(configured.status(), StatusCode::NO_CONTENT);

        let response = router
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(state.style_state.read().await.is_empty());
    }

    #[tokio::test]
    async fn config_rejects_more_style_sources_than_can_be_retained() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        let body = r#"{"sources":[
            {"id":"style-a","title":"A","tileSize":256,"minzoom":0,"maxzoom":20,"attribution":"",
             "upstream":{"mode":"style","styleUrl":"http://127.0.0.1/a","allowedHosts":["127.0.0.1"]}},
            {"id":"style-b","title":"B","tileSize":256,"minzoom":0,"maxzoom":20,"attribution":"",
             "upstream":{"mode":"style","styleUrl":"http://127.0.0.1/b","allowedHosts":["127.0.0.1"]}}
        ]}"#;
        let response = router
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(state.sources.read().await.is_empty());
        assert!(state.style_state.read().await.is_empty());
    }

    #[tokio::test]
    async fn stale_style_revalidates_conditionally_and_falls_back_offline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let conditional_seen = Arc::new(AtomicBool::new(false));
        let server_hits = hits.clone();
        let server_conditional = conditional_seen.clone();
        let upstream = Router::new().route(
            "/style",
            get(move |headers: axum::http::HeaderMap| {
                let hits = server_hits.clone();
                let conditional_seen = server_conditional.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    if headers.get(header::IF_NONE_MATCH).and_then(|value| value.to_str().ok())
                        == Some("\"upstream-v1\"")
                    {
                        conditional_seen.store(true, Ordering::Release);
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    (
                        [
                            (header::CONTENT_TYPE, "application/json"),
                            (header::ETAG, "\"upstream-v1\""),
                        ],
                        format!(
                            r#"{{"version":8,"sources":{{"map":{{"type":"vector","tiles":["http://{addr}/t/{{z}}/{{x}}/{{y}}"]}}}},"layers":[]}}"#,
                        ),
                    )
                        .into_response()
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        let mut state = AppState::new(
            cache,
            Knobs {
                allow_private_egress: true,
                fresh_secs: 1,
                ..Default::default()
            },
        );
        state.control_token = Some(Arc::from(TEST_CONTROL_TOKEN));
        let router = app(state.clone());
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        let first = router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        {
            let mut styles = state.style_state.write().await;
            Arc::make_mut(styles.get_mut("basemap").unwrap()).fetched_at =
                crate::state::now_secs() - 2;
        }
        let revalidated = router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(revalidated.status(), StatusCode::OK);
        assert!(conditional_seen.load(Ordering::Acquire));
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        server.abort();
        let _ = server.await;
        {
            let mut styles = state.style_state.write().await;
            Arc::make_mut(styles.get_mut("basemap").unwrap()).fetched_at =
                crate::state::now_secs() - 2;
        }
        let stale = router
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::OK);
        assert_eq!(stale.headers()["x-tilecache"], "stale");
        assert_eq!(
            stale.headers()[header::CACHE_CONTROL],
            crate::response::STALE_TILE_CACHE_CONTROL,
        );
    }

    #[tokio::test]
    async fn style_is_rewritten_and_its_tiles_and_glyphs_proxy() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();

        // The style document is rewritten so its glyphs and tiles point back at the plugin.
        let style_resp = router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(style_resp.status(), StatusCode::OK);
        let style = body_json(style_resp).await;
        assert_eq!(
            style["glyphs"],
            "/plugins/p/style/basemap/glyphs/{fontstack}/{range}.pbf"
        );
        assert_eq!(
            style["sources"]["openmaptiles"]["tiles"][0],
            "/plugins/p/style/basemap/tiles/openmaptiles/{z}/{x}/{y}"
        );
        assert!(
            style["sources"]["openmaptiles"].get("url").is_none(),
            "the upstream url is replaced by the proxied tiles"
        );

        // A vector tile is fetched, cached, and served.
        let tile = router
            .clone()
            .oneshot(
                Request::get("/style/basemap/tiles/openmaptiles/0/0/0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(tile.status(), StatusCode::OK);
        assert_eq!(
            tile.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/x-protobuf"
        );

        // A glyph range is proxied.
        let glyph = router
            .oneshot(
                Request::get("/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(glyph.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn unsafe_style_subresources_are_never_served_or_cached() {
        let addr = spawn_unsafe_asset_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        let style = router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(style.status(), StatusCode::OK);

        for uri in [
            "/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf",
            "/style/basemap/sprite.json",
            "/style/basemap/sprite.png",
            "/style/basemap/tiles/openmaptiles/0/0/0",
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY, "{uri}");
        }

        let generation = state.style_state.read().await["basemap"].generation;
        for (source, x) in [
            (
                glyph_cache_source_at("basemap", "Noto Sans Regular", generation),
                0,
            ),
            (sprite_cache_source_at("basemap", generation), 0),
            (sprite_cache_source_at("basemap", generation), 1),
            (
                vector_cache_source_at("basemap", "openmaptiles", generation),
                0,
            ),
        ] {
            assert!(
                state
                    .cache
                    .get(TileKey::new(&source, 0, x, 0))
                    .unwrap()
                    .is_none(),
                "unsafe subresource was not cached: {source}/{x}"
            );
        }
    }

    #[tokio::test]
    async fn style_conditionals_and_subresource_validation_are_strict() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        let first = router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let etag = first.headers()[header::ETAG].to_str().unwrap().to_string();
        let conditional = router
            .clone()
            .oneshot(
                Request::get("/style/basemap")
                    .header(header::IF_NONE_MATCH, format!("\"other\", W/{etag}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(conditional.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(conditional.headers()[header::ETAG], etag);
        assert!(conditional.headers().contains_key(header::CACHE_CONTROL));

        for (path, expected) in [
            (
                "/style/basemap/glyphs/Unknown%20Font/0-255.pbf",
                StatusCode::NOT_FOUND,
            ),
            (
                "/style/basemap/glyphs/Noto%20Sans%20Regular/1-256.pbf",
                StatusCode::NOT_FOUND,
            ),
            ("/style/basemap/tiles/unknown/0/0/0", StatusCode::NOT_FOUND),
            (
                "/style/basemap/tiles/openmaptiles/15/0/0",
                StatusCode::BAD_REQUEST,
            ),
            (
                "/style/basemap/tiles/openmaptiles/1/2/0",
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let response = router
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), expected, "{path}");
        }
    }

    #[tokio::test]
    async fn ensure_style_learned_records_tiles_and_source_maxzoom() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        crate::routes::app(st.clone())
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            crate::style::ensure_style_learned(&st, "basemap").await,
            "the style is learned"
        );
        let learned = st.style_state.read().await.get("basemap").cloned().unwrap();
        assert!(
            learned.source_tiles.contains_key("openmaptiles"),
            "the vector source tile template is learned"
        );
        assert_eq!(
            learned.source_maxzoom.get("openmaptiles"),
            Some(&14),
            "the vector source maxzoom is learned from its TileJSON"
        );
        let document = learned.document.clone();
        assert!(
            crate::style::ensure_style_learned(&st, "basemap").await,
            "a second call is idempotent"
        );
        let learned_again = st.style_state.read().await.get("basemap").cloned().unwrap();
        assert!(
            Arc::ptr_eq(&learned, &learned_again),
            "cached learned state is shared rather than deep-cloned"
        );
        assert!(
            Arc::ptr_eq(&document, &learned_again.document),
            "the parsed style document is Arc-backed"
        );
    }

    #[tokio::test]
    async fn learn_records_fontstacks_and_sprite_base() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        crate::routes::app(st.clone())
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(crate::style::ensure_style_learned(&st, "basemap").await);
        let ss = st.style_state.read().await;
        let learned = ss.get("basemap").unwrap();
        assert!(
            learned.fontstacks.iter().any(|f| f == "Noto Sans Regular"),
            "the multi-word fontstack is learned in decoded form"
        );
        assert_eq!(
            learned.sprite_base.as_deref(),
            Some(format!("http://{addr}/sprites/ofm").as_str()),
            "the sprite base is learned"
        );
    }

    #[tokio::test]
    async fn glyph_route_serves_a_cached_multi_word_fontstack_without_refetch() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        // Seed a cached glyph under the synthetic key with a body distinct from the upstream stub (7,7,7),
        // so serving the seed (not a refetch) is detectable.
        let generation = st.style_state.read().await["basemap"].generation;
        let key = crate::style::glyph_cache_source_at("basemap", "Noto Sans Regular", generation);
        let now = crate::state::now_secs();
        let tile = crate::cache::CachedTile {
            content_type: "application/x-protobuf".into(),
            strong_etag: "g".into(),
            upstream_validator: None,
            status: 200,
            fetched_at: now,
            last_access: now,
            bytes: 3,
            blob: Some(bytes::Bytes::from(vec![9u8, 9, 9])),
        };
        st.cache
            .put(TileKey::new(&key, 0, 0, 0), &tile, true, now)
            .unwrap();
        let resp = router
            .oneshot(
                Request::get("/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            body.as_ref(),
            &[9u8, 9, 9],
            "the cached glyph is served, not refetched"
        );
    }

    #[tokio::test]
    async fn an_unsafe_legacy_cached_glyph_is_not_used_as_offline_stale() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let generation = state.style_state.read().await["basemap"].generation;
        let key = glyph_cache_source_at("basemap", "Noto Sans Regular", generation);
        let fetched_at = crate::state::now_secs() - state.knobs.fresh_secs - 1;
        let body = bytes::Bytes::from_static(b"<script></script>");
        state
            .cache
            .put(
                TileKey::new(&key, 0, 0, 0),
                &crate::cache::CachedTile {
                    content_type: "text/html".into(),
                    strong_etag: crate::fetcher::strong_etag(&body),
                    upstream_validator: None,
                    status: 200,
                    fetched_at,
                    last_access: fetched_at,
                    bytes: body.len() as i64,
                    blob: Some(body),
                },
                false,
                fetched_at,
            )
            .unwrap();
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_address = closed.local_addr().unwrap();
        drop(closed);
        {
            let mut styles = state.style_state.write().await;
            Arc::make_mut(styles.get_mut("basemap").unwrap()).glyphs = Some(format!(
                "http://{closed_address}/fonts/{{fontstack}}/{{range}}.pbf"
            ));
        }

        let response = router
            .oneshot(
                Request::get("/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn glyph_route_serves_a_cached_negative_as_404() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let generation = st.style_state.read().await["basemap"].generation;
        let key = crate::style::glyph_cache_source_at("basemap", "Noto Sans Regular", generation);
        let now = crate::state::now_secs();
        let neg = crate::cache::CachedTile::negative(404, now);
        st.cache
            .put(TileKey::new(&key, 0, 0, 0), &neg, true, now)
            .unwrap();
        let resp = router
            .oneshot(
                Request::get("/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "a cached negative glyph serves as a 404"
        );
    }

    #[tokio::test]
    async fn sprite_route_proxies_caches_and_the_style_rewrites_sprite() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "127.0.0.1")))
                    .unwrap(),
            )
            .await
            .unwrap();
        let style_resp = router
            .clone()
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let style = body_json(style_resp).await;
        // The sprite URL is left absolute (upstream), not rewritten, because MapLibre rejects a
        // path-absolute sprite. The route still serves and caches the sprite for a later offline pass.
        assert_eq!(style["sprite"], format!("http://{addr}/sprites/ofm"));
        let sprite = router
            .clone()
            .oneshot(
                Request::get("/style/basemap/sprite.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(sprite.status(), StatusCode::OK);
        assert!(
            st.cache
                .get(TileKey::new(
                    &crate::style::sprite_cache_source_at(
                        "basemap",
                        st.style_state.read().await["basemap"].generation,
                    ),
                    0,
                    0,
                    0
                ))
                .unwrap()
                .is_some(),
            "sprite.json is cached under variant index 0"
        );
    }

    #[tokio::test]
    async fn config_rejects_a_style_url_off_the_allowed_hosts() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        let config = router
            .clone()
            .oneshot(
                Request::post("/config")
                    .header("content-type", "application/json")
                    .body(Body::from(config_json(addr, "not-allowed.example")))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(config.status(), StatusCode::BAD_REQUEST);
        let resp = router
            .oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "the rejected source never enters the allowlist"
        );
    }
}
