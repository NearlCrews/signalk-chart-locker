# Basemap region-warm Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a saved region include the vector basemap's geometry tiles, so the region renders its base layer offline (labels and icons are Phase 2).

**Architecture:** After the container learns the basemap style, each in-style source's upstream tile template is an XYZ template. The warm expands the `mode:'style'` source into synthetic XYZ sub-sources keyed `style:{source}:{name}`, clamped to each source's native maxzoom, and the existing warm path (`warm_one`, `expand_upstream`, `tiles_iter`, `put_many_pinned`) warms and pins them with no inner-loop changes. The cache key equals the serve key, so warmed tiles serve offline through the existing vector-tile route. The estimate clamps to a new `vectorMaxzoom` field inside the shared enumerator.

**Tech Stack:** Rust (axum, rusqlite, tokio, serde_json), shared TypeScript lib (`signalk-binnacle-chart-sources`, node:test), Svelte 5 webapp (vitest).

## Global Constraints

- No new heavy native libraries; the synthetic-source warm reuses the existing egress and cache paths.
- The container stays tokenless and Signal K agnostic; the warm fetches the upstream the learned style declares, guarded by `guarded_get` (the same egress guard the raster warm uses).
- The basemap is a region-download source only; it must never enter the position-warm Sources list.
- Never enumerate above a source's native maxzoom: clamp to `min(regionMaxzoom, vectorMaxzoom, learned source_maxzoom)`.
- Writing rules for all comments, commits, and docs: no em dashes, write "and" not an ampersand, Oxford commas, "chartplotter" one word, and never describe AI or review process.
- Gates green before each commit: Rust `cd container && cargo test --workspace` then `cargo clippy --workspace --all-targets -- -D warnings`; plugin `npm test && npm run typecheck && npm run lint && npm run build`; webapp `npm test && npm run check && npm run ci:biome`; chart-sources `npm test && npm run typecheck && npm run build`.

---

## Unit 1: Shared registry clamp (`signalk-binnacle-chart-sources`)

### Task 1: vectorMaxzoom field, the enumerator clamp, and the basemap value

**Files:**
- Modify: `/home/dietpi/src/signalk-binnacle-chart-sources/src/types.ts` (`ChartSource`, around line 24)
- Modify: `/home/dietpi/src/signalk-binnacle-chart-sources/src/mercator.ts` (`zoomBounds`, line 63)
- Modify: `/home/dietpi/src/signalk-binnacle-chart-sources/src/registry.ts` (the basemap entry, around line 83)
- Test: `/home/dietpi/src/signalk-binnacle-chart-sources/test/` (the mercator or estimate test file)

**Interfaces:**
- Produces: `ChartSource.vectorMaxzoom?: number`; `zoomBounds` clamps to it; the basemap source carries `vectorMaxzoom: 14`.

- [ ] **Step 1: Write the failing test**

In the chart-sources test that covers `tileCountInBbox` (match the existing file and import style):

```ts
test('tileCountInBbox clamps a vector source to vectorMaxzoom even when asked for a higher zoom', () => {
  const basemap = CHART_SOURCES.find((s) => s.id === 'basemap')!
  // The basemap maxzoom is 20 but vectorMaxzoom is 14; a request for z0..16 must enumerate no tiles above 14.
  const wide = tileCountInBbox(basemap, [-10, 40, 10, 55], [0, 16])
  const at14 = tileCountInBbox(basemap, [-10, 40, 10, 55], [0, 14])
  assert.equal(wide, at14, 'the count clamps to vectorMaxzoom (14), so z15 and z16 add nothing')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/src/signalk-binnacle-chart-sources && npm test`
Expected: FAIL (`vectorMaxzoom` undefined, so the basemap still enumerates to z16).

- [ ] **Step 3: Add the field, the clamp, and the value**

In `types.ts` `ChartSource`, after `maxzoom: number`:

```ts
  /** The native vector-tile maxzoom, distinct from maxzoom (the MapLibre overzoom render ceiling).
   * Present on a vector style source; the warm and the estimate clamp to it so they never request
   * vector tiles above the level the upstream actually serves. */
  vectorMaxzoom?: number
```

In `mercator.ts` `zoomBounds`:

```ts
function zoomBounds (source: ChartSource, [zmin, zmax]: [number, number]): [number, number] {
  return [Math.max(zmin, source.minzoom), Math.min(zmax, source.maxzoom, source.vectorMaxzoom ?? source.maxzoom)]
}
```

In `registry.ts`, the basemap entry, add `vectorMaxzoom: 14` (Liberty and OpenMapTiles native vector maxzoom):

```ts
    id: 'basemap', title: 'OpenFreeMap Liberty', tileSize: 256,
    minzoom: 0, maxzoom: 20, vectorMaxzoom: 14,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/src/signalk-binnacle-chart-sources && npm test`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
cd ~/src/signalk-binnacle-chart-sources && npm run typecheck && npm run build
git add src/types.ts src/mercator.ts src/registry.ts test/
git commit -m "feat: clamp the basemap estimate to a native vectorMaxzoom"
```

Note: the plugin and the webapp consume this lib via a `file:` link, so the change is picked up by their next install or build. If they vendor a copy under `node_modules/signalk-binnacle-chart-sources`, refresh it (`npm install` in each consumer) before their gates.

---

## Unit 2: Webapp basemap selection (`signalk-binnacle`)

### Task 2: Unfilter the basemap into the region list only, exclude it from auto-select and position warm

**Files:**
- Modify: `src/features/prewarm/estimate.ts` (`regionSources` line 20, add `positionWarmSources`, a `BASEMAP_SOURCE_ID` constant)
- Modify: `src/features/prewarm/RegionsPanel.svelte` (the position-warm source list around line 83 and 775, the auto-select in the draw `onChange` around line 155)
- Test: `src/features/prewarm/estimate.test.ts` (flip the two exclusion tests, add a position-warm exclusion test)

**Interfaces:**
- Consumes: `tileCountInBbox` clamp from Task 1.
- Produces: `regionSources()` includes the basemap; `positionWarmSources()` excludes it; a `BASEMAP_SOURCE_ID` export; the panel uses `positionWarmSources()` for the position-warm list and excludes the basemap from a new box's auto-select.

- [ ] **Step 1: Write and flip the tests**

In `estimate.test.ts`, flip the two exclusion tests and add the position-warm one:

```ts
it('includes the basemap in the region source list', () => {
  expect(regionSources().some((s) => s.id === 'basemap')).toBe(true);
  expect(regionSources().some((s) => s.id === 'seamark')).toBe(true);
});
```

and (in the `coveringSources` describe, replacing 'excludes the style basemap'):

```ts
it('includes the basemap for a non-empty box', () => {
  const bbox: [number, number, number, number] = [-10, 40, 10, 55];
  expect(coveringSources(bbox, [6, 12]).some((s) => s.id === 'basemap')).toBe(true);
});
```

and add a new test importing `positionWarmSources`:

```ts
it('positionWarmSources excludes the basemap', () => {
  expect(positionWarmSources().some((s) => s.id === 'basemap')).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/src/signalk-binnacle && npm test -- estimate`
Expected: FAIL (`regionSources` still filters style, `positionWarmSources` not exported).

- [ ] **Step 3: Implement**

In `estimate.ts`:

```ts
/** The basemap source id; the region list includes it, the position-warm list and the new-box
 * auto-select exclude it (it is global and large). */
export const BASEMAP_SOURCE_ID = 'basemap';

/** The registry sources offered for a region download, including the vector basemap. */
export function regionSources(): ChartSource[] {
  return CHART_SOURCES.filter((s) => s.upstream.mode !== 'style' || s.id === BASEMAP_SOURCE_ID);
}

/** The sources offered for position warm: never the basemap (warming a whole basemap per GPS fix is
 * wrong) and never any other style source. */
export function positionWarmSources(): ChartSource[] {
  return CHART_SOURCES.filter((s) => s.upstream.mode !== 'style');
}
```

(Leave `coveringSources` as-is: it calls `regionSources()`, so it now includes the basemap for a non-empty box.)

In `RegionsPanel.svelte`:
- Change the import from `./estimate.js` to add `BASEMAP_SOURCE_ID` and `positionWarmSources`, and remove `regionSources` from the position-warm usage.
- Replace `const regionSourceList = regionSources();` (the position-warm list seed, around line 83) with `const regionSourceList = positionWarmSources();`.
- In the draw `onChange` auto-select (around line 155), exclude the basemap so a new box does not auto-select it:

```ts
    selectedSources =
      newBbox === null
        ? []
        : coveringSources(newBbox, [minzoom, maxzoom])
            .filter((s) => s.id !== BASEMAP_SOURCE_ID)
            .map((s) => s.id);
```

- Update the stale comments at `estimate.ts:19`, `estimate.ts:25`, and `RegionsPanel.svelte` lines 113 and 158 that say the style basemap is excluded.

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/src/signalk-binnacle && npm test -- estimate`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
cd ~/src/signalk-binnacle && npm test && npm run check && npm run ci:biome
git add src/features/prewarm/estimate.ts src/features/prewarm/estimate.test.ts src/features/prewarm/RegionsPanel.svelte
git commit -m "feat(regions): offer the basemap as a region source, not in position warm or auto-select"
```

---

## Unit 3: Rust source and state fields (`container/tilecache`)

### Task 3: vector_maxzoom on ChartSource and source_maxzoom on StyleState

**Files:**
- Modify: `container/tilecache/src/source.rs` (`ChartSource`, after `maxzoom`, line 15)
- Modify: `container/tilecache/src/state.rs` (`StyleState`, around line 75)
- Test: `container/tilecache/src/source.rs` (tests module)

**Interfaces:**
- Produces: `ChartSource.vector_maxzoom: Option<u32>` (serde `vectorMaxzoom`, default `None`); `StyleState.source_maxzoom: HashMap<String, u32>`.

- [ ] **Step 1: Write the failing test**

Add to `source.rs` tests:

```rust
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
        ).unwrap();
        assert_eq!(without.vector_maxzoom, None);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container && cargo test -p binnacle-tilecache deserializes_vector_maxzoom`
Expected: FAIL (no field).

- [ ] **Step 3: Add the fields**

In `source.rs` `ChartSource`, after `pub maxzoom: u32,`:

```rust
    #[serde(default)]
    pub vector_maxzoom: Option<u32>,
```

In `state.rs` `StyleState`:

```rust
#[derive(Clone, Default)]
pub struct StyleState {
    pub glyphs: Option<String>,
    pub source_tiles: HashMap<String, Vec<String>>,
    pub source_maxzoom: HashMap<String, u32>,
}
```

This breaks the one `StyleState { glyphs, source_tiles }` literal in `style.rs:123`; Task 4 updates it.

- [ ] **Step 4: Run to verify pass (source test) and confirm the build break is only the known literal**

Run: `cd container && cargo test -p binnacle-tilecache deserializes_vector_maxzoom 2>&1 | head -30`
Expected: the source test passes once `style.rs:123` is updated in Task 4; until then the crate fails to compile only at that literal. Proceed to Task 4 before gating.

- [ ] **Step 5: Commit (with Task 4, since the crate does not compile alone)**

Defer the commit to the end of Task 4.

---

## Unit 4: Style learning reachable from the warm (`container/tilecache`)

### Task 4: ensure_style_learned, learn source_maxzoom and update the literal

**Files:**
- Modify: `container/tilecache/src/style.rs` (factor the learn out of `style_doc`, add `ensure_style_learned`, learn `source_maxzoom`, update the `StyleState` literal at line 123)
- Test: `container/tilecache/src/style.rs` (tests module)

**Interfaces:**
- Consumes: `StyleState.source_maxzoom` (Task 3).
- Produces: `pub async fn ensure_style_learned(state: &AppState, source: &str) -> bool` populating `StyleState` (idempotent: returns true without refetch when already learned); `style_doc` reuses the same learn; `source_maxzoom` learned from each source's inline `maxzoom` or its TileJSON `maxzoom`.

- [ ] **Step 1: Write the failing test**

Add to `style.rs` tests (the existing `spawn_upstream` stub serves a vector source via TileJSON; extend it to include a `maxzoom` in the TileJSON, then assert `ensure_style_learned` records it):

First, in `spawn_upstream`, add `maxzoom` to the TileJSON response:

```rust
            .route(
                "/tiles.json",
                get(move || async move {
                    ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#))
                }),
            )
```

Then add the test:

```rust
    #[tokio::test]
    async fn ensure_style_learned_records_tiles_and_source_maxzoom() {
        let addr = spawn_upstream().await;
        let db = NamedTempFile::new().unwrap();
        let st = dev_state(&db);
        // Push the basemap source into the allowlist (the config JSON shape the tests use).
        crate::routes::app(st.clone())
            .oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr, "127.0.0.1"))).unwrap())
            .await.unwrap();
        assert!(crate::style::ensure_style_learned(&st, "basemap").await, "the style is learned");
        let ss = st.style_state.read().await;
        let learned = ss.get("basemap").unwrap();
        assert!(learned.source_tiles.contains_key("openmaptiles"), "the vector source tile template is learned");
        assert_eq!(learned.source_maxzoom.get("openmaptiles"), Some(&14), "the vector source maxzoom is learned from its TileJSON");
        // Idempotent: a second call returns true without a refetch.
        assert!(crate::style::ensure_style_learned(&st, "basemap").await);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container && cargo test -p binnacle-tilecache ensure_style_learned_records`
Expected: FAIL (function does not exist; crate also still has the broken literal from Task 3).

- [ ] **Step 3: Refactor style.rs**

Factor the fetch-and-learn out of `style_doc` into a shared helper, learning `source_maxzoom`, and add `ensure_style_learned`. Replace the body of `style_doc` and add the helpers:

```rust
/// Fetch the upstream style, learn its glyph template, per-source tile templates, and per-source
/// maxzoom (inline or from the source's TileJSON), store the StyleState, and return the parsed style
/// document and its allowed hosts for the caller to rewrite and serve. Returns None on any fetch or
/// host-check failure.
async fn fetch_and_learn(state: &AppState, source: &str) -> Option<(Value, Vec<String>)> {
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

    let mut source_tiles: HashMap<String, Vec<String>> = HashMap::new();
    let mut source_maxzoom: HashMap<String, u32> = HashMap::new();
    let names: Vec<String> = style
        .get("sources").and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect()).unwrap_or_default();
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
    state.style_state.write().await.insert(source.to_string(), StyleState { glyphs, source_tiles, source_maxzoom });
    Some((style, allowed))
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
```

Rewrite `style_doc` to call `fetch_and_learn` and then rewrite the served document from the learned StyleState:

```rust
async fn style_doc(State(state): State<AppState>, Path(source): Path<String>) -> Response {
    let Some((mut style, _allowed)) = fetch_and_learn(&state, &source).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let public = state.public_base.read().await.clone();
    let learned = { state.style_state.read().await.get(&source).cloned() };
    let Some(learned) = learned else { return StatusCode::BAD_GATEWAY.into_response() };

    if learned.glyphs.is_some() {
        style["glyphs"] = Value::String(format!("{public}/style/{source}/glyphs/{{fontstack}}/{{range}}.pbf"));
    }
    for name in learned.source_tiles.keys() {
        if let Some(obj) = style["sources"][name].as_object_mut() {
            obj.remove("url");
            obj.insert(
                "tiles".to_string(),
                Value::Array(vec![Value::String(format!("{public}/style/{source}/tiles/{name}/{{z}}/{{x}}/{{y}}"))]),
            );
        }
    }
    let body = match serde_json::to_vec(&style) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}
```

(The `StyleState { glyphs, source_tiles, source_maxzoom }` literal now lives only in `fetch_and_learn`, resolving the Task 3 build break. `Value` and `HashMap` are already imported.)

- [ ] **Step 4: Run to verify pass**

Run: `cd container && cargo test -p binnacle-tilecache style:: ensure_style_learned`
Expected: PASS (the new test plus the existing `style_is_rewritten_and_its_tiles_and_glyphs_proxy`, which still rewrites correctly through the learned StyleState).

- [ ] **Step 5: Commit Units 3 and 4 together**

```bash
cd ~/src/signalk-chart-locker && cargo -C container clippy --workspace --all-targets -- -D warnings 2>/dev/null || (cd container && cargo clippy --workspace --all-targets -- -D warnings)
git add container/tilecache/src/source.rs container/tilecache/src/state.rs container/tilecache/src/style.rs
git commit -m "feat(tilecache): learn the basemap style and its source maxzoom from the warm path"
```

---

## Unit 5: Warm a style source as synthetic XYZ sub-sources (`container/tilecache`)

### Task 5: Expand a style source in start_warm count and in run

**Files:**
- Modify: `container/tilecache/src/warm.rs` (the `start_warm` total loop around line 84, and `run` around line 222 to expand a style source before enumeration)
- Test: `container/tilecache/src/warm.rs` (tests module)

**Interfaces:**
- Consumes: `ensure_style_learned` (Task 4), `StyleState.source_tiles` and `source_maxzoom`, `ChartSource.vector_maxzoom`.
- Produces: a style source in a warm request enumerates each in-style source as a synthetic XYZ source keyed `style:{source}:{name}`, clamped to `min(regionMaxzoom, vector_maxzoom, learned source_maxzoom)`, pinned under the region.

- [ ] **Step 1: Write the failing test**

Add to `warm.rs` tests a style-source warm. It reuses the `style.rs` upstream stub shape via a local stub; build a style source in the allowlist, then warm it and assert a vector tile is pinned under the cache key `style:basemap:openmaptiles`:

```rust
    async fn style_stub() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let a = addr;
        let app = Router::new()
            .route("/style", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(
                    r#"{{"version":8,"sources":{{"openmaptiles":{{"type":"vector","url":"http://{a}/tiles.json"}}}},"layers":[]}}"#))
            }))
            .route("/tiles.json", get(move || async move {
                ([(header::CONTENT_TYPE, "application/json")], format!(r#"{{"tiles":["http://{a}/t/{{z}}/{{x}}/{{y}}.pbf"],"maxzoom":14}}"#))
            }))
            .route("/t/:z/:x/:y", get(|| async { ([(header::CONTENT_TYPE, "application/x-protobuf")], vec![8u8, 8, 8, 8]) }));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    fn style_source(addr: SocketAddr) -> ChartSource {
        ChartSource {
            id: "basemap".into(), title: "B".into(),
            upstream: UpstreamTemplate::Style { style_url: format!("http://{addr}/style"), allowed_hosts: vec!["127.0.0.1".into()] },
            tile_size: 256, minzoom: 0, maxzoom: 20, vector_maxzoom: Some(14), bounds: None, attribution: String::new(),
        }
    }

    #[tokio::test]
    async fn warm_pins_basemap_vector_tiles_under_the_style_cache_key() {
        let addr = style_stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        let job = start_warm(&st, WarmRequest { sources: vec![src], bbox: [-1.0, -1.0, 1.0, 1.0], minzoom: 0, maxzoom: 2, region_id: Some("r1".into()) }).await.unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        assert!(snap["done"].as_u64().unwrap() >= 1, "at least one vector tile warmed");
        // The tile is stored under the serve key style:basemap:openmaptiles and is pinned.
        st.cache.evict_to(0).unwrap();
        assert!(st.cache.get("style:basemap:openmaptiles", 0, 0, 0).unwrap().is_some(), "the basemap vector tile is pinned under the style cache key");
    }

    #[tokio::test]
    async fn warm_clamps_basemap_to_the_native_maxzoom() {
        let addr = style_stub().await;
        let db = NamedTempFile::new().unwrap();
        let st = state(&db, dev(), style_source(addr)).await;
        let src = st.sources.read().await["basemap"].clone();
        // Request z0..16, above the native 14; nothing above 14 is enumerated. With a tiny box the count
        // is small; assert the job completes and no z15 tile exists.
        let job = start_warm(&st, WarmRequest { sources: vec![src], bbox: [-0.01, -0.01, 0.01, 0.01], minzoom: 14, maxzoom: 16, region_id: Some("r1".into()) }).await.unwrap();
        let snap = wait_done(&st, &job).await;
        assert_eq!(snap["state"], "done");
        // z14 may exist; z15 and z16 never do.
        assert!(st.cache.get("style:basemap:openmaptiles", 15, 0, 0).unwrap().is_none(), "no tile above the native maxzoom");
    }
```

(Add `use axum::routing::get;` and `use axum::Router;` and `header` to the test module imports if not already present; they are, from the existing stub.)

- [ ] **Step 2: Run to verify failure**

Run: `cd container && cargo test -p binnacle-tilecache warm_pins_basemap warm_clamps_basemap`
Expected: FAIL (`start_warm` rejects the style source with `UnknownSource` today).

- [ ] **Step 3: Implement the style expansion**

Add a helper in `warm.rs` (after `effective_budget`):

```rust
// Expand a style source into one synthetic XYZ sub-source per learned in-style source, keyed
// style:{source}:{name} so the warm writes the exact key the vector-tile serve route reads. Each
// sub-source is clamped to the minimum of the registry vector_maxzoom and the learned source maxzoom,
// so the enumeration never requests a tile above what the upstream serves. A non-style source passes
// through unchanged.
async fn expand_warm_sources(st: &AppState, sources: Vec<ChartSource>) -> Vec<ChartSource> {
    let mut out = Vec::new();
    for source in sources {
        if !matches!(source.upstream, UpstreamTemplate::Style { .. }) {
            out.push(source);
            continue;
        }
        if !crate::style::ensure_style_learned(st, &source.id).await {
            continue;
        }
        let learned = { st.style_state.read().await.get(&source.id).cloned() };
        let Some(learned) = learned else { continue };
        let registry_max = source.vector_maxzoom.unwrap_or(source.maxzoom);
        for (name, templates) in &learned.source_tiles {
            let Some(template) = templates.first() else { continue };
            let native = learned.source_maxzoom.get(name).copied().unwrap_or(registry_max);
            out.push(ChartSource {
                id: format!("style:{}:{}", source.id, name),
                title: source.title.clone(),
                upstream: UpstreamTemplate::Xyz { url_template: template.clone() },
                tile_size: source.tile_size,
                minzoom: source.minzoom,
                maxzoom: registry_max.min(native),
                vector_maxzoom: None,
                bounds: None,
                attribution: source.attribution.clone(),
            });
        }
    }
    out
}
```

In `start_warm`, replace the total-count match arm so a style source is counted at its clamped maxzoom instead of rejected:

```rust
        for s in &req.sources {
            match map.get(&s.id) {
                Some(known) if matches!(known.upstream, UpstreamTemplate::Style { .. }) => {
                    // The style is not fetched yet, so count one sub-source's worth at the registry
                    // vector maxzoom for the hard-cap gate; run() enumerates each learned sub-source.
                    let clamp = known.vector_maxzoom.unwrap_or(known.maxzoom).min(known.maxzoom);
                    let mut tmp = known.clone();
                    tmp.maxzoom = clamp;
                    total += tile_count_in_bbox(&tmp, b, req.minzoom, req.maxzoom);
                }
                Some(known) => {
                    total += tile_count_in_bbox(known, b, req.minzoom, req.maxzoom);
                }
                None => return Err(StartError::UnknownSource(s.id.clone())),
            }
        }
```

In `run`, expand the sources before enumeration. Change the signature use: after the `delete_region` call and before building the JoinSet, expand:

```rust
    let sources = expand_warm_sources(&st, sources).await;
```

(Insert that line right after the `if let Some(rid) = region_id.as_deref() { ... delete_region ... }` block, so the expansion runs once and the existing `'outer: for source in &sources` loop enumerates the synthetic sub-sources.)

- [ ] **Step 4: Run to verify pass**

Run: `cd container && cargo test -p binnacle-tilecache warm_pins_basemap warm_clamps_basemap`
Expected: PASS.

- [ ] **Step 5: Full Rust gate and commit**

```bash
cd container && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo build --release --bin tilecache
git add container/tilecache/src/warm.rs
git commit -m "feat(tilecache): warm a basemap region as synthetic XYZ sub-sources clamped to native maxzoom"
```

---

## Unit 6: Plugin gate (no code change expected)

### Task 6: Confirm the plugin warms a basemap region end to end

The plugin already forwards `sourceIds` to the container `/warm` and re-validates the estimate. With the basemap now a valid warm source, a region whose `sourceIds` include `basemap` flows through unchanged. The server-side gate's `estimateBytes(['basemap'], ...)` looks up `perSourceAvgBytes['basemap']`, which is absent (tiles store under `style:basemap:openmaptiles`), so it falls back to `DEFAULT_TILE_BYTES`, a conservative upper bound. This is the documented Phase-1 behavior.

- [ ] **Step 1: Run the plugin gate**

Run: `cd ~/src/signalk-chart-locker && npm test && npm run typecheck && npm run lint && npm run build`
Expected: green (no plugin code change). If a route test asserts the basemap is rejected, update it to allow a basemap region.

- [ ] **Step 2: Commit only if a test changed**

```bash
git add test/
git commit -m "test(plugin): allow a basemap region through the warm route"
```
(Skip if nothing changed.)

---

## Self-Review

**Spec coverage:**
- vectorMaxzoom field, clamp in the enumerator, basemap value: Task 1.
- Basemap selectable in the region list only, not position warm, not auto-selected; flipped tests: Task 2.
- Rust vector_maxzoom and source_maxzoom: Task 3.
- ensure_style_learned reachable from the warm, source_maxzoom learned inline and from TileJSON: Task 4.
- Style source warmed as synthetic XYZ sub-sources keyed style:{source}:{name}, clamped, pinned under the region; start_warm total includes the clamped count: Task 5.
- Server-side gate default-average fallback documented: Task 6.

**Placeholder scan:** none.

**Type consistency:** `vectorMaxzoom` (TS) and `vector_maxzoom` (Rust, serde camelCase) match; `BASEMAP_SOURCE_ID` and `positionWarmSources` are defined in Task 2 and used in the panel; `ensure_style_learned` is defined in Task 4 and called in Task 5; the synthetic id `style:{source}:{name}` equals the serve key `style:{source}:{name}` at `style.rs:155`; `StyleState { glyphs, source_tiles, source_maxzoom }` is constructed only in `fetch_and_learn`.

## Known limitation (Phase 1)

A Phase-1 basemap region renders geometry offline but not labels or icons (no glyphs, no sprite). That
is Phase 2. The warm fetches the basemap vector tiles through `guarded_get`, the same egress guard the
raster warm uses; the upstream host is whatever the trusted style document (fetched from the
allowlisted styleUrl) declares.
