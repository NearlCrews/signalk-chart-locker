# Basemap region-warm Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a basemap region render fully offline by warming and serving the font glyphs and the sprite (labels and icons), all in the container.

**Architecture:** Glyphs and the sprite are stored in the existing `tiles` table under synthetic keys (`style:{src}:glyphs:{fontstack}` at `x=rangeStart`; `style:{src}:sprite` at `x=variantIndex`). The glyph route gains a cache-first read keyed by the decoded fontstack; four explicit sprite routes serve the sprite cache-first; the style proxy rewrites the `sprite` URL. The warm driver, when it warms a basemap region to `Done`, warms the global assets once, cache-first per key, pinned under a reserved `__basemap_assets__` pseudo-region, single-flight via an `Arc<AtomicBool>` in `AppState`.

**Tech Stack:** Rust (axum 0.7, rusqlite, tokio, serde_json), `container/tilecache`.

## Global Constraints

- No new heavy native libraries; assets are opaque bytes (no image decoding).
- Every asset fetch host-checks against the style allowed hosts (`host_allowed`) and uses the guarded egress path; the guarded path alone blocks only private and loopback IPs.
- The cache key uses the canonical DECODED comma-joined fontstack on both warm and serve; URL-encode the fontstack ONLY when building the upstream URL.
- The assets warm is cache-first per key (`pin_if_fresh` skip, fetch the misses), so it is idempotent, recovers a partial set, and never re-fetches a pinned asset.
- The assets path builds `CachedTile`/`WarmRow` directly (NOT through `warm_one`), because `acceptable_content_type` rejects the sprite JSON (`application/json`).
- The assets warm runs only when the region warm finished `Done`, never changes the region job's `total` or `done`, and bounds fan-out through `warm_semaphore`.
- Writing rules for all comments and commits: no em dashes, write "and" not an ampersand, Oxford commas, "chartplotter" one word, no AI-process talk.
- Gate green before each commit: `cd container && cargo test --workspace` then `cargo clippy --workspace --all-targets -- -D warnings`. The full Rust gate plus `cargo build --release --bin tilecache` runs at the end.

---

## Unit 1: Learn fontstacks and sprite base

### Task 1: StyleState fields and the learn step

**Files:**
- Modify: `container/tilecache/src/state.rs` (`StyleState`, around line 75; add a `__basemap_assets__` constant near `POSITION_WARM_REGION_ID` at line 23; add `assets_warming` to `AppState` and `AppState::new`)
- Modify: `container/tilecache/src/style.rs` (`fetch_and_learn`: parse fontstacks and sprite base)
- Test: `container/tilecache/src/style.rs` (tests)

**Interfaces:**
- Produces: `StyleState.fontstacks: Vec<String>`, `StyleState.sprite_base: Option<String>`; `state::BASEMAP_ASSETS_REGION_ID`; `AppState.assets_warming: Arc<AtomicBool>`.

- [ ] **Step 1: Write the failing test**

Extend the `style.rs` test stub `spawn_upstream` so the style has a layer with a multi-word `text-font` and a `sprite` URL, then assert the learn records them. Change the `/style` route body to:

```rust
                    let body = format!(
                        r#"{{"version":8,"glyphs":"http://{a}/fonts/{{fontstack}}/{{range}}.pbf","sprite":"http://{a}/sprites/ofm","sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[{{"id":"l","type":"symbol","layout":{{"text-font":["Noto Sans Regular"]}}}}]}}"#
                    );
```

and add a sprite stub route to `spawn_upstream`:

```rust
            .route("/sprites/:name", get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":1}"#) }))
```

Add the test:

```rust
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
        assert_eq!(learned.sprite_base.as_deref(), Some(&*format!("http://{addr}/sprites/ofm")), "the sprite base is learned");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container && cargo test -p binnacle-tilecache learn_records_fontstacks`
Expected: FAIL (fields do not exist).

- [ ] **Step 3: Add the constant, the AppState flag, and the StyleState fields**

In `state.rs`, near `POSITION_WARM_REGION_ID`:

```rust
/// The reserved pseudo-region id under which the global basemap assets (font glyphs and the sprite)
/// are pinned. Mirrors POSITION_WARM_REGION_ID: it counts once toward the regions budget R.
pub const BASEMAP_ASSETS_REGION_ID: &str = "__basemap_assets__";
```

In `StyleState`:

```rust
#[derive(Clone, Default)]
pub struct StyleState {
    pub glyphs: Option<String>,
    pub source_tiles: HashMap<String, Vec<String>>,
    pub source_maxzoom: HashMap<String, u32>,
    pub fontstacks: Vec<String>,
    pub sprite_base: Option<String>,
}
```

In `AppState`, after `live_scroll_ttl_secs` (use `AtomicBool`, already importable via `std::sync::atomic`):

```rust
    /// Single-flight guard for the one-time global basemap assets warm, so two concurrent basemap
    /// downloads do not both fetch the full glyph and sprite set.
    pub assets_warming: Arc<std::sync::atomic::AtomicBool>,
```

In `AppState::new`, add to the struct literal:

```rust
            assets_warming: Arc::new(std::sync::atomic::AtomicBool::new(false)),
```

In `style.rs` `fetch_and_learn`, after computing `glyphs` and before the sources loop, learn the sprite base and the fontstacks from the already-parsed `style`:

```rust
    let sprite_base = style.get("sprite").and_then(|v| v.as_str()).map(String::from);
    let mut fontstacks: Vec<String> = Vec::new();
    if let Some(layers) = style.get("layers").and_then(|v| v.as_array()) {
        for layer in layers {
            // text-font is a plain string array on a static style; tolerate a non-array (data-driven)
            // value by skipping it rather than panicking.
            if let Some(arr) = layer.get("layout").and_then(|l| l.get("text-font")).and_then(|v| v.as_array()) {
                let joined: String = arr.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(",");
                if !joined.is_empty() && !fontstacks.contains(&joined) {
                    fontstacks.push(joined);
                }
            }
        }
    }
```

and store them in the `StyleState` literal at the end of `fetch_and_learn`:

```rust
    state.style_state.write().await.insert(source.to_string(), StyleState { glyphs, source_tiles, source_maxzoom, fontstacks, sprite_base });
```

- [ ] **Step 4: Run to verify pass**

Run: `cd container && cargo test -p binnacle-tilecache learn_records_fontstacks`
Expected: PASS. (The existing `ensure_style_learned_records...` and `style_is_rewritten...` tests still pass; the new `text-font` and `sprite` keys do not change the rewrite.)

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/state.rs container/tilecache/src/style.rs
git commit -m "feat(tilecache): learn the basemap fontstacks and sprite base"
```

---

## Unit 2: Synthetic key helpers and a cache-first glyph route

### Task 2: glyph_cache_source, the decoded key, and the cache-first glyph route

**Files:**
- Modify: `container/tilecache/src/style.rs` (add `glyph_cache_source` and `sprite_cache_source` helpers, rewrite the `glyphs` route cache-first, parse `rangeStart`)
- Test: `container/tilecache/src/style.rs` (tests)

**Interfaces:**
- Produces: `pub fn glyph_cache_source(style_source: &str, fontstack: &str) -> String`; `pub fn sprite_cache_source(style_source: &str) -> String`; `pub fn glyph_range_start(range: &str) -> Option<u32>`; the glyph route serves cache-first.

- [ ] **Step 1: Write the failing test**

Add a warm-then-serve test proving the cache-first key matches for a multi-word fontstack. It seeds the cache directly under the synthetic glyph key (simulating a warm), then asserts the glyph route serves it without a second upstream fetch (point a hit counter at the upstream font route):

```rust
    #[tokio::test]
    async fn glyph_route_serves_a_cached_multi_word_fontstack_without_refetch() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap()).await.unwrap();
        // Learn the style so the glyph template and the allowed hosts resolve.
        router.clone().oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap()).await.unwrap();
        // Seed a cached glyph under the synthetic key for "Noto Sans Regular", range 0-255.
        let key = crate::style::glyph_cache_source("basemap", "Noto Sans Regular");
        let now = crate::state::now_secs();
        let tile = crate::cache::CachedTile {
            content_type: "application/x-protobuf".into(), strong_etag: "g".into(), upstream_validator: None,
            status: 200, fetched_at: now, last_access: now, bytes: 3, blob: Some(bytes::Bytes::from(vec![7u8, 7, 7])),
        };
        st.cache.put(&key, 0, 0, 0, &tile, true, now).unwrap();
        // The serve route returns the cached glyph (the path param decodes %20 to a space).
        let resp = router.oneshot(Request::get("/style/basemap/glyphs/Noto%20Sans%20Regular/0-255.pbf").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.as_ref(), &[7u8, 7, 7], "the cached glyph is served, not refetched");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container && cargo test -p binnacle-tilecache glyph_route_serves_a_cached`
Expected: FAIL (helpers absent; route does not read the cache).

- [ ] **Step 3: Add the helpers and rewrite the glyph route**

In `style.rs`, add the pure helpers (near the top, after the imports):

```rust
/// The synthetic cache source for a fontstack's glyph ranges. The fontstack is the canonical DECODED
/// comma-joined form (the axum path param after decoding), so the warm-write and serve-read keys match.
pub fn glyph_cache_source(style_source: &str, fontstack: &str) -> String {
    format!("style:{style_source}:glyphs:{fontstack}")
}

/// The synthetic cache source for the sprite variants.
pub fn sprite_cache_source(style_source: &str) -> String {
    format!("style:{style_source}:sprite")
}

/// Parse the 256-aligned range start from a glyph range param like `0-255.pbf`. Returns None for a
/// malformed or non-256-aligned range so a crafted range cannot mis-key the cache.
pub fn glyph_range_start(range: &str) -> Option<u32> {
    let start: u32 = range.split('-').next()?.parse().ok()?;
    if start % 256 == 0 { Some(start) } else { None }
}
```

Rewrite the `glyphs` route to be cache-first (replace its body):

```rust
async fn glyphs(State(state): State<AppState>, Path((source, fontstack, range)): Path<(String, String, String)>) -> Response {
    let Some(range_start) = glyph_range_start(&range) else { return StatusCode::NOT_FOUND.into_response() };
    let cache_source = glyph_cache_source(&source, &fontstack);

    // Cache first (also the offline path). A cached negative (zero-byte) row serves as a 404.
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
    let encoded = encode_fontstack(&fontstack);
    // The learned template carries literal {fontstack} and {range}.pbf; the incoming range already ends in .pbf.
    let upstream = template.replace("{fontstack}", &encoded).replace("{range}.pbf", &range);
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
```

Add a small encode helper (percent-encode the fontstack segment for the upstream URL only):

```rust
/// Percent-encode a fontstack for an upstream glyph URL segment (the cache key uses the decoded form).
/// A space becomes %20; commas and other path-safe characters are left as the glyph server expects.
fn encode_fontstack(fontstack: &str) -> String {
    fontstack.replace(' ', "%20")
}
```

(`Ordering` is imported at `style.rs:21`. `CachedTile` is imported. `now_secs` is imported.)

- [ ] **Step 4: Run to verify pass**

Run: `cd container && cargo test -p binnacle-tilecache glyph_route_serves_a_cached glyph_range_start`
Expected: PASS. The existing `style_is_rewritten_and_its_tiles_and_glyphs_proxy` test still passes (its fontstack `NotoSans` has no space, range `0-255` is 256-aligned, and the upstream stub returns the bytes).

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/style.rs
git commit -m "feat(tilecache): cache-first glyph route keyed by the decoded fontstack"
```

---

## Unit 3: Sprite route

### Task 3: Four explicit sprite routes, cache-first, and the style rewrite

**Files:**
- Modify: `container/tilecache/src/style.rs` (`style_routes` add four routes, a `sprite_variant` handler, rewrite the `sprite` value in `style_doc`)
- Test: `container/tilecache/src/style.rs` (tests)

**Interfaces:**
- Produces: `GET /style/:source/sprite.json`, `/sprite.png`, `/sprite@2x.json`, `/sprite@2x.png`, each cache-first under `sprite_cache_source` at `x = variantIndex`; the served style document's `sprite` is rewritten to `{public}/style/{source}/sprite`.

- [ ] **Step 1: Write the failing test**

```rust
    #[tokio::test]
    async fn sprite_route_proxies_caches_and_the_style_rewrites_sprite() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        let router = crate::routes::app(st.clone());
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap()).await.unwrap();
        // The style document rewrites the sprite to the plugin path.
        let style_resp = router.clone().oneshot(Request::get("/style/basemap").body(Body::empty()).unwrap()).await.unwrap();
        let style = body_json(style_resp).await;
        assert_eq!(style["sprite"], "/plugins/p/style/basemap/sprite");
        // The sprite.json variant proxies and caches (no slash before the suffix).
        let sprite = router.clone().oneshot(Request::get("/style/basemap/sprite.json").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(sprite.status(), StatusCode::OK);
        assert!(st.cache.get(&crate::style::sprite_cache_source("basemap"), 0, 0, 0).unwrap().is_some(), "sprite.json is cached under variant index 0");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container && cargo test -p binnacle-tilecache sprite_route_proxies`
Expected: FAIL (no sprite route; sprite not rewritten).

- [ ] **Step 3: Add the routes, the handler, and the rewrite**

In `style_routes`:

```rust
        .route("/style/:source/sprite.json", get(|s, p| sprite_variant(s, p, 0, ".json")))
        .route("/style/:source/sprite.png", get(|s, p| sprite_variant(s, p, 1, ".png")))
        .route("/style/:source/sprite@2x.json", get(|s, p| sprite_variant(s, p, 2, "@2x.json")))
        .route("/style/:source/sprite@2x.png", get(|s, p| sprite_variant(s, p, 3, "@2x.png")))
```

If the closure form does not type-check against axum 0.7 handler bounds, use four thin named handlers instead (each calls `sprite_variant(state, source, idx, suffix)`); the plan's intent is one shared `sprite_variant` with four entry points.

Add the handler:

```rust
async fn sprite_variant(State(state): State<AppState>, Path(source): Path<String>, variant: u32, suffix: &str) -> Response {
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
```

In `style_doc`, after the glyphs and sources rewrite, rewrite the sprite when learned:

```rust
    if learned.sprite_base.is_some() {
        style["sprite"] = Value::String(format!("{public}/style/{source}/sprite"));
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd container && cargo test -p binnacle-tilecache sprite_route_proxies`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/style.rs
git commit -m "feat(tilecache): proxy and cache the basemap sprite, rewrite the style sprite url"
```

---

## Unit 4: The assets warm driver folded into run

### Task 4: Warm the global glyphs and sprite once on a Done basemap region warm

**Files:**
- Modify: `container/tilecache/src/warm.rs` (capture the style source before `expand_warm_sources`; add `warm_basemap_assets`; call it after a `Done` region warm; an RAII single-flight guard)
- Test: `container/tilecache/src/warm.rs` (tests)

**Interfaces:**
- Consumes: `state::BASEMAP_ASSETS_REGION_ID`, `AppState.assets_warming`, `style::glyph_cache_source`, `style::sprite_cache_source`, `StyleState.fontstacks`, `StyleState.sprite_base`, `StyleState.glyphs`, `pin_if_fresh`, `put_many_pinned`, `effective_budget`, `fetch_upstream`, `host_allowed` (re-export or a small local host check).

- [ ] **Step 1: Write the failing test**

```rust
    #[tokio::test]
    async fn a_basemap_warm_pins_the_global_glyphs_and_sprite_once() {
        let addr = style_stub_with_assets().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        let job = start_warm(&st, WarmRequest { sources: vec![src], bbox: [-0.5, -0.5, 0.5, 0.5], minzoom: 0, maxzoom: 1, region_id: Some("r1".into()) }).await.unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        // Allow the folded assets warm to finish (it runs after the region tiles, same task).
        // A glyph range and the sprite are pinned under __basemap_assets__.
        let gk = crate::style::glyph_cache_source("basemap", "Noto Sans Regular");
        st.cache.evict_to(0).unwrap();
        assert!(st.cache.get(&gk, 0, 0, 0).unwrap().is_some(), "a glyph range is pinned under the assets region");
        let sk = crate::style::sprite_cache_source("basemap");
        assert!(st.cache.get(&sk, 0, 0, 0).unwrap().is_some(), "the sprite json is pinned");
        // region_bytes for the assets region is non-zero.
        assert!(st.cache.region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID).unwrap() > 0);
    }
```

Add a `style_stub_with_assets` to the warm tests that serves a style with a `glyphs` template, a `sprite`, a layer `text-font`, and the upstream `fonts`, `sprites`, `tiles.json`, and `t` routes (mirroring the `style.rs` stub):

```rust
    async fn style_stub_with_assets() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let a = addr;
        let app = Router::new()
            .route("/style", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(
                    r#"{{"version":8,"glyphs":"http://{a}/fonts/{{fontstack}}/{{range}}.pbf","sprite":"http://{a}/sprites/ofm","sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[{{"id":"l","type":"symbol","layout":{{"text-font":["Noto Sans Regular"]}}}}]}}"#))
            }))
            .route("/tiles.json", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#))
            }))
            .route("/t/:z/:x/:y", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![8u8, 8, 8, 8]) }))
            .route("/fonts/:fontstack/:range", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![7u8, 7, 7]) }))
            .route("/sprites/:name", get(|| async { ([(header::CONTENT_TYPE, "application/json")], r#"{"ok":1}"#) }));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }
```

(The `style_source` helper from the Phase 1 tests already builds the basemap `ChartSource`; the `state()` helper sets `live_regions_budget = cap` so the assets fit.)

- [ ] **Step 2: Run to verify failure**

Run: `cd container && cargo test -p binnacle-tilecache a_basemap_warm_pins_the_global`
Expected: FAIL (no assets warm).

- [ ] **Step 3: Implement the assets warm and the trigger**

In `warm.rs`, capture the style source id before `expand_warm_sources` shadows the list. Change `run` so that right before `let sources = expand_warm_sources(&st, sources).await;` it records:

```rust
    // Capture the style source (if any) before expansion replaces it with synthetic XYZ sub-sources,
    // so the folded assets warm can look up the learned glyph template, fontstacks, and sprite base.
    let style_source_id: Option<String> = sources.iter()
        .find(|s| matches!(s.upstream, UpstreamTemplate::Style { .. }))
        .map(|s| s.id.clone());
    let sources = expand_warm_sources(&st, sources).await;
```

At the end of `run`, after `j.state = final_state;` and `j.finished_at = ...`, drop the job lock and warm the assets when the region warm finished `Done` and a style source was present:

```rust
    drop(j);
    if final_state == WarmState::Done {
        if let Some(style_id) = style_source_id {
            warm_basemap_assets(&st, &style_id).await;
        }
    }
```

Add the assets warm and an RAII single-flight guard:

```rust
// Glyph codepoint ranges to warm: U+0000 through U+2FFF, 256 wide.
const GLYPH_RANGE_STARTS: std::ops::Range<u32> = 0..12288; // stepped by 256 below

struct AssetsFlag<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for AssetsFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

// Warm the global basemap glyphs and the sprite once, cache-first per key, pinned under
// __basemap_assets__. Single-flight via the AppState flag (reset on every exit by the RAII guard).
// Each asset is skipped when already fresh-pinned, so this is idempotent and recovers a partial set.
async fn warm_basemap_assets(st: &AppState, style_source: &str) {
    use std::sync::atomic::AtomicBool;
    if st.assets_warming.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return; // another warm is fetching the set
    }
    let _flag: AssetsFlag = AssetsFlag(&st.assets_warming);
    let region = crate::state::BASEMAP_ASSETS_REGION_ID;
    let (glyph_template, fontstacks, sprite_base, allowed) = {
        let ss = st.style_state.read().await;
        let Some(s) = ss.get(style_source) else { return };
        let allowed = match st.sources.read().await.get(style_source).map(|c| c.upstream.clone()) {
            Some(UpstreamTemplate::Style { allowed_hosts, .. }) => allowed_hosts,
            _ => return,
        };
        (s.glyphs.clone(), s.fontstacks.clone(), s.sprite_base.clone(), allowed)
    };
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    let mut batch: Vec<WarmRow> = Vec::with_capacity(WARM_BATCH);

    if let Some(template) = glyph_template {
        for fontstack in &fontstacks {
            let cache_source = crate::style::glyph_cache_source(style_source, fontstack);
            let encoded = fontstack.replace(' ', "%20");
            for range_start in GLYPH_RANGE_STARTS.step_by(256) {
                let range = format!("{range_start}-{}", range_start + 255);
                let url = template.replace("{fontstack}", &encoded).replace("{range}.pbf", &format!("{range}.pbf"));
                warm_one_asset(st, &cache_source, range_start, &url, &allowed, region, &mut batch).await;
                if batch.len() >= WARM_BATCH && !flush(st, &dummy_job(), &mut batch, Some(region), &mut WarmState::Done).await {
                    return;
                }
            }
        }
    }
    if let Some(base) = sprite_base {
        let cache_source = crate::style::sprite_cache_source(style_source);
        for (idx, suffix) in [(0u32, ".json"), (1, ".png"), (2, "@2x.json"), (3, "@2x.png")] {
            let url = format!("{base}{suffix}");
            warm_one_asset(st, &cache_source, idx, &url, &allowed, region, &mut batch).await;
        }
    }
    if !batch.is_empty() {
        flush(st, &dummy_job(), &mut batch, Some(region), &mut WarmState::Done).await;
    }
    let _ = (region, cap, AtomicBool::new(false));
}
```

NOTE FOR THE IMPLEMENTER: `flush` takes a `&Arc<Mutex<WarmJob>>` for its counters; the assets warm must not touch the region job. Resolve this in implementation by ONE of: (a) give `flush` an optional job and pass `None` for assets, or (b) add a small `flush_pinned(st, &mut batch, region, budget, cap) -> bool` that calls `put_many_pinned` directly without a job, and use it here. Option (b) is cleaner and avoids a dummy job; do option (b) and delete the `dummy_job()` references above. Define:

```rust
async fn flush_pinned(st: &AppState, batch: &mut Vec<WarmRow>, region: &str) {
    let now = now_secs();
    let budget = effective_budget(st, Some(region));
    let cap = st.live_cap_bytes.load(Ordering::Relaxed);
    crate::fetcher::log_cache_err(st.cache.put_many_pinned(batch, budget, cap, Some(region), now).map(|_| ()));
    batch.clear();
}
```

and call `flush_pinned(st, &mut batch, region).await;` at the batch boundary and the tail.

`warm_one_asset` builds the `WarmRow` directly (cache-first skip, then fetch, bypassing the content-type gate so the sprite JSON stores):

```rust
async fn warm_one_asset(st: &AppState, cache_source: &str, x: u32, url: &str, allowed: &[String], region: &str, batch: &mut Vec<WarmRow>) {
    let now = now_secs();
    // Cache-first: skip an already fresh-pinned asset (idempotent, recovers a partial set, no refetch).
    match st.cache.pin_if_fresh(cache_source, 0, x, 0, now, st.knobs.fresh_secs, st.knobs.negative_ttl_secs, effective_budget(st, Some(region)), Some(region)) {
        Ok(true) => return,
        Ok(false) => {}
        Err(e) => eprintln!("tilecache: assets pin_if_fresh failed: {e}"),
    }
    if !crate::style::host_allowed_pub(url, allowed) {
        return;
    }
    let _permit = match st.warm_semaphore.clone().acquire_owned().await { Ok(p) => p, Err(_) => return };
    match crate::fetcher::fetch_upstream(st, url, None).await {
        Ok((200, f)) => {
            batch.push(WarmRow {
                source: cache_source.to_string(), z: 0, x, y: 0,
                tile: CachedTile {
                    content_type: f.content_type, strong_etag: crate::fetcher::strong_etag(&f.body), upstream_validator: None,
                    status: 200, fetched_at: now, last_access: now, bytes: f.body.len() as i64, blob: Some(f.body),
                },
            });
        }
        Ok((404, _)) | Ok((204, _)) => {
            batch.push(WarmRow {
                source: cache_source.to_string(), z: 0, x, y: 0,
                tile: CachedTile { content_type: String::new(), strong_etag: String::new(), upstream_validator: None, status: 404, fetched_at: now, last_access: now, bytes: 0, blob: None },
            });
        }
        _ => {}
    }
}
```

Expose `host_allowed` for the warm: in `style.rs` add `pub fn host_allowed_pub(url: &str, allowed_hosts: &[String]) -> bool { host_allowed(url, allowed_hosts) }` (or make `host_allowed` `pub(crate)` and call it directly). Simplify the assets warm to call `crate::style::host_allowed_pub`.

Final shape: delete the `dummy_job`, `GLYPH_RANGE_STARTS` as a `Range` is fine with `.step_by(256)`, and the trailing `let _ = (...)` line. The implementer wires `flush_pinned` at the batch boundary and the tail.

- [ ] **Step 4: Run to verify pass**

Run: `cd container && cargo test -p binnacle-tilecache a_basemap_warm_pins_the_global`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/warm.rs container/tilecache/src/style.rs
git commit -m "feat(tilecache): warm the global basemap glyphs and sprite under a reserved region"
```

---

## Unit 5: Idempotence and single-flight tests, full gate

### Task 5: Idempotent second run and the trigger guard, then the full gate

**Files:**
- Test: `container/tilecache/src/warm.rs` (tests)

- [ ] **Step 1: Add the idempotence and non-basemap tests**

```rust
    #[tokio::test]
    async fn a_second_basemap_warm_adds_no_duplicate_asset_bytes() {
        let addr = style_stub_with_assets().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        let j1 = start_warm(&st, WarmRequest { sources: vec![src.clone()], bbox: [-0.5, -0.5, 0.5, 0.5], minzoom: 0, maxzoom: 0, region_id: Some("r1".into()) }).await.unwrap();
        wait_done(&st, &j1).await;
        let after_first = st.cache.region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID).unwrap();
        let j2 = start_warm(&st, WarmRequest { sources: vec![src], bbox: [-0.5, -0.5, 0.5, 0.5], minzoom: 0, maxzoom: 0, region_id: Some("r1".into()) }).await.unwrap();
        wait_done(&st, &j2).await;
        let after_second = st.cache.region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID).unwrap();
        assert_eq!(after_first, after_second, "the second basemap warm adds no duplicate asset bytes");
        assert!(after_first > 0);
    }

    #[tokio::test]
    async fn a_non_basemap_warm_pins_no_assets() {
        let addr = stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), xyz(addr, "img")).await;
        let job = start_warm(&st, WarmRequest { sources: vec![st.sources.read().await["s"].clone()], bbox: [-1.0, -1.0, 1.0, 1.0], minzoom: 0, maxzoom: 0, region_id: Some("r1".into()) }).await.unwrap();
        wait_done(&st, &job).await;
        assert_eq!(st.cache.region_bytes(crate::state::BASEMAP_ASSETS_REGION_ID).unwrap(), 0, "a raster warm pins no basemap assets");
    }
```

- [ ] **Step 2: Run to verify pass**

Run: `cd container && cargo test -p binnacle-tilecache a_second_basemap_warm a_non_basemap_warm`
Expected: PASS.

- [ ] **Step 3: Full Rust gate**

```bash
cd container && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo build --release --bin tilecache
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add container/tilecache/src/warm.rs
git commit -m "test(tilecache): idempotent basemap assets warm and the non-basemap no-op"
```

---

## Self-Review

**Spec coverage:**
- Learn fontstacks and sprite base: Task 1.
- Synthetic keys and cache-first glyph route keyed by the decoded fontstack: Task 2.
- Four explicit sprite routes and the style rewrite: Task 3.
- Assets warm folded into run, cache-first per key, single-flight, Done-only, capture-before-expansion, direct WarmRow for the sprite JSON, host-checked: Task 4.
- Idempotence and the non-basemap no-op: Task 5.

**Placeholder scan:** the Task 4 step carries an explicit implementer note to choose `flush_pinned` (option b) and delete the `dummy_job` scaffolding; that is a resolved decision, not a placeholder.

**Type consistency:** `glyph_cache_source`, `sprite_cache_source`, `glyph_range_start`, and `host_allowed_pub` are defined in `style.rs` (Tasks 2 and 4) and called in `style.rs` and `warm.rs`; `BASEMAP_ASSETS_REGION_ID` and `assets_warming` are defined in `state.rs` (Task 1) and used in `warm.rs` (Task 4); the synthetic glyph key uses the decoded fontstack on both the serve route (Task 2) and the warm (Task 4); `WarmRow.source` equals the serve cache key.

## Known limitations (Phase 2)

- The assets warm runs only on a `Done` basemap region warm; a capped or cancelled region warm leaves
  labels and icons online-only until the next successful basemap region warm.
- `__basemap_assets__` is never reclaimed, so deleting the last basemap region leaves the assets pinned
  (a few MB of R). Documented; a later refinement could reclaim them.
- The region job shows `done == total` while the assets phase runs; this is correct (the region tiles
  are done) and the panel reads the region as complete.
