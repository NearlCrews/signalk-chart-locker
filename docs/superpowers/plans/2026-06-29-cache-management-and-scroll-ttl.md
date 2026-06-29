# Cache management and scroll-tile TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an age-based scroll-tile TTL (reclaim unpinned tiles not accessed within N days) and a cache-management section in the regions panel (breakdown, TTL control, clear-scroll button).

**Architecture:** Three layers, each extending an existing seam. The Rust container (`container/tilecache`) gains a live TTL field seeded from an env variable, an age sweep and a clear-scroll method on `TileCache`, a tokio sweep task, per-source totals in the stats JSON, and two new container routes (a dedicated live-TTL setter and a clear-scroll). The Node plugin (`src/`) stores `cacheScrollTtlDays` in the regions-store, folds the TTL seconds into the start `/config` push, and adds three admin-gated routes. The webapp panel (`signalk-binnacle`) adds a "Scroll cache" section reusing existing primitives.

**Tech Stack:** Rust (axum, rusqlite bundled SQLite, tokio), TypeScript Node plugin (node:test via tsx), Svelte 5 webapp (vitest, MapLibre).

## Global Constraints

- The runtime image links only libc, libm, libgcc, and the loader: no new heavy native libraries. `tokio::time::interval` is already in the tree; add nothing else.
- The container is tokenless and Signal K agnostic: new routes take an integer or nothing, never a path or host, and never widen egress. Day-to-seconds conversion happens at the plugin edge.
- Pinned tiles (saved regions and position-warm) are never evicted by the sweep or the clear: every delete carries `WHERE pinned = 0`.
- SI and unit discipline: TTL is days at the UI and in the plugin config, seconds in the container. Bytes are bytes throughout.
- Writing rules for all code comments, commits, and docs: no em dashes, write "and" not an ampersand, Oxford commas, "chartplotter" is one word, and never describe AI or review process.
- Keep `total_bytes` and `pinned_bytes` invariants exact: the sweep and the clear decrement `inner.total_bytes` by the freed bytes under the cache lock and leave `inner.pinned_bytes` unchanged.
- Run the project gates green before each commit: for Rust `cd container && cargo test --workspace` then `cargo clippy --workspace --all-targets -- -D warnings`; for the plugin `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`; for the webapp `npm test`, `npm run check`, `npm run ci:biome`.

---

## Unit A: Rust container (`container/tilecache`)

### Task A1: Partial index on unpinned last_access

**Files:**
- Modify: `container/tilecache/src/cache.rs` (the `ensure_schema` function, around line 91)
- Test: `container/tilecache/src/cache.rs` (the `#[cfg(test)] mod tests` block)

**Interfaces:**
- Produces: a partial index `idx_tiles_scroll_lru ON tiles(last_access) WHERE pinned = 0`, created unconditionally on every open so existing caches gain it without a schema-version wipe.

- [ ] **Step 1: Write the failing test**

Add to the tests module in `cache.rs`:

```rust
    #[test]
    fn open_creates_the_scroll_lru_partial_index() {
        let (_f, c) = open();
        let inner = c.lock();
        let count: i64 = inner
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_tiles_scroll_lru'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "the partial scroll-LRU index exists after open");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container && cargo test -p binnacle-tilecache open_creates_the_scroll_lru_partial_index`
Expected: FAIL (the index does not exist yet).

- [ ] **Step 3: Add the index**

In `ensure_schema`, after the closing brace of the `if version != SCHEMA_VERSION { ... }` block and before `Ok(())`, add an unconditional create:

```rust
        // Speeds the age sweep and the LRU window without a schema-version wipe: created on every open
        // so an existing cache gains it. Partial on pinned = 0 because only scroll rows are swept or
        // LRU-evicted, which also bounds the index write cost on pinned writes.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_tiles_scroll_lru ON tiles(last_access) WHERE pinned = 0;",
        )?;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container && cargo test -p binnacle-tilecache open_creates_the_scroll_lru_partial_index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/cache.rs
git commit -m "feat(tilecache): index unpinned last_access for the scroll sweep"
```

### Task A2: Age-sweep and clear-scroll cache methods

**Files:**
- Modify: `container/tilecache/src/cache.rs` (add two methods to `impl TileCache`, after `evict_to`, around line 234; add one chunk constant near `SCHEMA_VERSION`)
- Test: `container/tilecache/src/cache.rs` (tests module)

**Interfaces:**
- Produces:
  - `pub fn sweep_aged_unpinned(&self, ttl_secs: i64, now: i64) -> rusqlite::Result<(i64, i64)>` returning `(freed_bytes, freed_rows)`. A no-op returning `(0, 0)` when `ttl_secs <= 0`. Deletes only `pinned = 0` rows with `last_access < now - ttl_secs`, decrements `total_bytes`, leaves `pinned_bytes` unchanged.
  - `pub fn clear_unpinned(&self) -> rusqlite::Result<(i64, i64)>` returning `(freed_bytes, freed_rows)`. Deletes all `pinned = 0` rows, decrements `total_bytes` to equal `pinned_bytes`, leaves `pinned_bytes` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the tests module in `cache.rs`:

```rust
    #[test]
    fn sweep_aged_unpinned_deletes_old_scroll_rows_keeps_fresh_and_pinned() {
        let (_f, c) = open();
        // Pinned region tile at an old access time: must survive regardless of age.
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), true, 0).unwrap();
        // Old unpinned scroll tile (last_access = 100): swept.
        c.put("s", 0, 0, 1, &tile(20, 200, Some(vec![0; 20])), false, 100).unwrap();
        // Fresh unpinned scroll tile (last_access = 10_000): kept.
        c.put("s", 0, 0, 2, &tile(30, 200, Some(vec![0; 30])), false, 10_000).unwrap();
        // now = 10_000, ttl = 1000, cutoff = 9000. Only the last_access=100 row is older than cutoff.
        let (freed_bytes, freed_rows) = c.sweep_aged_unpinned(1000, 10_000).unwrap();
        assert_eq!((freed_bytes, freed_rows), (20, 1), "exactly the one old scroll tile is freed");
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "the pinned tile survives");
        assert!(c.get("s", 0, 0, 1).unwrap().is_none(), "the old scroll tile is swept");
        assert!(c.get("s", 0, 0, 2).unwrap().is_some(), "the fresh scroll tile survives");
        let (_rows, total, pinned) = c.stats().unwrap();
        assert_eq!(total, 40, "total decremented by the freed 20: 10 pinned + 30 fresh");
        assert_eq!(pinned, 10, "pinned_bytes unchanged");
    }

    #[test]
    fn sweep_aged_unpinned_is_a_no_op_when_ttl_is_zero() {
        let (_f, c) = open();
        c.put("s", 0, 0, 1, &tile(20, 200, Some(vec![0; 20])), false, 1).unwrap();
        let (freed_bytes, freed_rows) = c.sweep_aged_unpinned(0, 10_000).unwrap();
        assert_eq!((freed_bytes, freed_rows), (0, 0), "ttl 0 disables the sweep");
        assert!(c.get("s", 0, 0, 1).unwrap().is_some(), "the row survives a disabled sweep");
    }

    #[test]
    fn clear_unpinned_deletes_all_scroll_rows_and_keeps_pinned() {
        let (_f, c) = open();
        c.put("s", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), true, 0).unwrap(); // pinned
        c.put("s", 0, 0, 1, &tile(20, 200, Some(vec![0; 20])), false, 5).unwrap(); // scroll
        c.put("s", 0, 0, 2, &tile(30, 200, Some(vec![0; 30])), false, 9_999).unwrap(); // fresh scroll
        let (freed_bytes, freed_rows) = c.clear_unpinned().unwrap();
        assert_eq!((freed_bytes, freed_rows), (50, 2), "both scroll tiles freed regardless of age");
        assert!(c.get("s", 0, 0, 0).unwrap().is_some(), "the pinned tile survives the clear");
        let (_rows, total, pinned) = c.stats().unwrap();
        assert_eq!(total, 10, "total equals pinned after the clear");
        assert_eq!(pinned, 10, "pinned_bytes unchanged");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container && cargo test -p binnacle-tilecache sweep_aged_unpinned clear_unpinned`
Expected: FAIL (methods not defined).

- [ ] **Step 3: Add the chunk constant and the two methods**

Near `SCHEMA_VERSION` at the top of `cache.rs`, add:

```rust
/// Rows deleted per chunk by the age sweep and the clear, so a large reclaim releases the single
/// connection lock between chunks rather than stalling all tile serving in one long DELETE. A plain
/// `DELETE ... LIMIT` is unavailable (the bundled SQLite is built without
/// SQLITE_ENABLE_UPDATE_DELETE_LIMIT), so the delete targets a bounded `rowid IN (SELECT ... LIMIT)`.
const DELETE_CHUNK: i64 = 4096;
```

In `impl TileCache`, after `evict_to`, add:

```rust
    /// Delete unpinned scroll rows whose `last_access` is older than `now - ttl_secs`, in bounded
    /// chunks that release the lock between chunks. A no-op when `ttl_secs <= 0`. Never deletes a
    /// pinned row. Decrements `total_bytes` by the freed bytes; leaves `pinned_bytes` unchanged.
    /// Returns the freed bytes and the freed row count. Relies on the invariant that an unpinned row
    /// (`pinned = 0`) carries no `region_tiles` join row, so deleting it leaves no orphan join row:
    /// the pin paths set `pinned = 1` and the join row together, and `delete_region` clears both.
    pub fn sweep_aged_unpinned(&self, ttl_secs: i64, now: i64) -> rusqlite::Result<(i64, i64)> {
        if ttl_secs <= 0 {
            return Ok((0, 0));
        }
        let cutoff = now - ttl_secs;
        let mut freed_bytes = 0i64;
        let mut freed_rows = 0i64;
        loop {
            let mut inner = self.lock();
            // The SUM and the DELETE share the identical subquery under the held lock, so they target
            // the same rowset; the ORDER BY makes the LIMIT deterministic (oldest first).
            let chunk_bytes: i64 = inner.conn.query_row(
                "SELECT COALESCE(SUM(bytes), 0) FROM tiles WHERE rowid IN \
                 (SELECT rowid FROM tiles WHERE pinned = 0 AND last_access < ?1 ORDER BY last_access ASC LIMIT ?2)",
                params![cutoff, DELETE_CHUNK],
                |r| r.get(0),
            )?;
            let n = inner.conn.execute(
                "DELETE FROM tiles WHERE rowid IN \
                 (SELECT rowid FROM tiles WHERE pinned = 0 AND last_access < ?1 ORDER BY last_access ASC LIMIT ?2)",
                params![cutoff, DELETE_CHUNK],
            )? as i64;
            inner.total_bytes -= chunk_bytes;
            drop(inner);
            freed_bytes += chunk_bytes;
            freed_rows += n;
            if n < DELETE_CHUNK {
                break;
            }
        }
        Ok((freed_bytes, freed_rows))
    }

    /// Delete every unpinned scroll row, in bounded chunks that release the lock between chunks. Never
    /// deletes a pinned row, so `total_bytes` settles at `pinned_bytes`. Leaves `pinned_bytes`
    /// unchanged. Returns the freed bytes and the freed row count. Like the age sweep, this relies on
    /// the invariant that an unpinned row carries no `region_tiles` join row, so it leaves none orphaned.
    pub fn clear_unpinned(&self) -> rusqlite::Result<(i64, i64)> {
        let mut freed_bytes = 0i64;
        let mut freed_rows = 0i64;
        loop {
            let mut inner = self.lock();
            let chunk_bytes: i64 = inner.conn.query_row(
                "SELECT COALESCE(SUM(bytes), 0) FROM tiles WHERE rowid IN \
                 (SELECT rowid FROM tiles WHERE pinned = 0 LIMIT ?1)",
                params![DELETE_CHUNK],
                |r| r.get(0),
            )?;
            let n = inner.conn.execute(
                "DELETE FROM tiles WHERE rowid IN (SELECT rowid FROM tiles WHERE pinned = 0 LIMIT ?1)",
                params![DELETE_CHUNK],
            )? as i64;
            inner.total_bytes -= chunk_bytes;
            drop(inner);
            freed_bytes += chunk_bytes;
            freed_rows += n;
            if n < DELETE_CHUNK {
                break;
            }
        }
        Ok((freed_bytes, freed_rows))
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container && cargo test -p binnacle-tilecache sweep_aged_unpinned clear_unpinned`
Expected: PASS (all three new tests).

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/cache.rs
git commit -m "feat(tilecache): add the scroll age sweep and clear-unpinned cache methods"
```

### Task A3: Per-source totals method and stats bySource

**Files:**
- Modify: `container/tilecache/src/cache.rs` (add `per_source_totals` after `per_source_avg`, around line 533)
- Modify: `container/tilecache/src/routes.rs` (the `stats` handler, around line 39)
- Test: `container/tilecache/src/cache.rs` (tests module) and `container/tilecache/src/routes.rs` (tests module)

**Interfaces:**
- Produces: `pub fn per_source_totals(&self) -> rusqlite::Result<Vec<(String, i64, i64)>>` returning `(source, bytes, rows)` over `pinned = 0` rows, ordered by source. The `stats` JSON gains a `bySource` array of `{ source, bytes, rows }`.

- [ ] **Step 1: Write the failing tests**

Add to the `cache.rs` tests module:

```rust
    #[test]
    fn per_source_totals_sums_scroll_rows_per_source() {
        let (_f, c) = open();
        c.put("a", 0, 0, 0, &tile(100, 200, Some(vec![0; 100])), false, 1).unwrap();
        c.put("a", 0, 0, 1, &tile(40, 200, Some(vec![0; 40])), false, 1).unwrap();
        c.put("b", 0, 0, 0, &tile(10, 200, Some(vec![0; 10])), false, 1).unwrap();
        // A pinned row is excluded from the scroll totals.
        c.put("a", 0, 0, 2, &tile(1000, 200, Some(vec![0; 1000])), true, 1).unwrap();
        let totals = c.per_source_totals().unwrap();
        assert_eq!(totals, vec![("a".to_string(), 140, 2), ("b".to_string(), 10, 1)]);
    }
```

Add to the `routes.rs` tests module:

```rust
    #[tokio::test]
    async fn cache_stats_reports_by_source() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let router = app(dev_state(&db));
        router.clone().oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(config_json(addr))).unwrap()).await.unwrap();
        router.clone().oneshot(Request::get("/tile/s/1/0/0").body(Body::empty()).unwrap()).await.unwrap();
        let resp = router.oneshot(Request::get("/cache/stats").body(Body::empty()).unwrap()).await.unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"bySource\""), "stats reports the per-source totals array");
        assert!(body.contains("\"source\":\"s\""), "the warmed source appears in the per-source totals");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container && cargo test -p binnacle-tilecache per_source_totals cache_stats_reports_by_source`
Expected: FAIL.

- [ ] **Step 3: Add the method and extend the stats JSON**

In `cache.rs`, after `per_source_avg`:

```rust
    /// The total stored bytes and the row count per source over UNPINNED scroll rows only, so the
    /// cache-management breakdown reports what the scroll cache holds by source. Computed on demand;
    /// `/cache/stats` is called rarely.
    pub fn per_source_totals(&self) -> rusqlite::Result<Vec<(String, i64, i64)>> {
        let inner = self.lock();
        let mut stmt = inner.conn.prepare(
            "SELECT source, COALESCE(SUM(bytes), 0), COUNT(*) FROM tiles WHERE pinned = 0 GROUP BY source ORDER BY source",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?;
        rows.collect()
    }
```

In `routes.rs` `stats`, before the `Json(serde_json::json!({ ... }))`, build the array:

```rust
    let by_source: Vec<serde_json::Value> = st
        .cache
        .per_source_totals()
        .unwrap_or_default()
        .into_iter()
        .map(|(source, bytes, rows)| serde_json::json!({ "source": source, "bytes": bytes, "rows": rows }))
        .collect();
```

and add the field to the JSON object (after `"perSourceAvgBytes": avg,`):

```rust
        "bySource": by_source,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container && cargo test -p binnacle-tilecache per_source_totals cache_stats_reports_by_source`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/cache.rs container/tilecache/src/routes.rs
git commit -m "feat(tilecache): report per-source scroll totals in cache stats"
```

### Task A4: Live TTL field, env seed, and the start /config field

**Files:**
- Modify: `container/tilecache/src/state.rs` (`Knobs` around line 48, `AppState` around line 108, `AppState::new` around line 112)
- Modify: `container/tilecache/src/routes.rs` (`ConfigBody` around line 77, `config` handler around line 100)
- Modify: `container/tilecache/src/main.rs` (env read around line 19, `Knobs` build around line 29)
- Test: `container/tilecache/src/routes.rs` (tests module)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AppState.live_scroll_ttl_secs: Arc<AtomicI64>`, seeded from `Knobs.scroll_ttl_secs`. `ConfigBody` gains `scroll_ttl_secs: Option<i64>`; `config` stores it into `live_scroll_ttl_secs`. `main.rs` reads `TILECACHE_SCROLL_TTL_SECS` into `Knobs.scroll_ttl_secs`.

- [ ] **Step 1: Write the failing test**

Add to the `routes.rs` tests module. It holds the `AppState` and asserts the pushed `scrollTtlSecs` reaches `live_scroll_ttl_secs`, so it genuinely fails before the field exists (it will not compile until `live_scroll_ttl_secs` is added):

```rust
    #[tokio::test]
    async fn config_sets_the_live_scroll_ttl() {
        let hits = Arc::new(AtomicUsize::new(0));
        let addr = spawn_stub(hits).await;
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        let router = app(state.clone());
        let cfg = format!(
            r#"{{"sources":[{{"id":"s","title":"S","tileSize":256,"minzoom":0,"maxzoom":18,"attribution":"",
                "upstream":{{"mode":"xyz","urlTemplate":"http://{addr}/img/{{z}}/{{x}}/{{y}}"}}}}],"publicBase":"/p","scrollTtlSecs":86400}}"#
        );
        let resp = router.oneshot(Request::post("/config").header("content-type", "application/json").body(Body::from(cfg)).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert_eq!(state.live_scroll_ttl_secs.load(Ordering::Relaxed), 86_400, "the pushed TTL reaches the live field");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container && cargo test -p binnacle-tilecache config_sets_the_live_scroll_ttl`
Expected: FAIL (does not compile: `live_scroll_ttl_secs` does not exist on `AppState` yet).

- [ ] **Step 3: Add the field, the state, and the env seed**

In `state.rs` `Knobs`, add a field:

```rust
    /// The scroll-tile TTL in seconds, seeded from the env at construction so the startup sweep has a
    /// value before the plugin's first /config push. Zero disables the age sweep.
    pub scroll_ttl_secs: i64,
```

In `Knobs` `Default`, add `scroll_ttl_secs: 0,`.

In `AppState`, add a field after `live_position_warm_budget`:

```rust
    /// The live scroll-tile TTL in seconds, seeded from `knobs.scroll_ttl_secs` and updated by the
    /// dedicated POST /cache/scroll-ttl route. Zero disables the age sweep.
    pub live_scroll_ttl_secs: Arc<AtomicI64>,
```

In `AppState::new`, capture and seed it (next to `let cap_bytes = knobs.cap_bytes;`):

```rust
        let scroll_ttl_secs = knobs.scroll_ttl_secs;
```

and in the struct literal, after `live_position_warm_budget: ...`:

```rust
            live_scroll_ttl_secs: Arc::new(AtomicI64::new(scroll_ttl_secs)),
```

In `routes.rs` `ConfigBody`, add:

```rust
    #[serde(default)]
    scroll_ttl_secs: Option<i64>,
```

In `config`, after the `position_warm_budget_bytes` block:

```rust
    if let Some(t) = body.scroll_ttl_secs {
        st.live_scroll_ttl_secs.store(t, Ordering::Relaxed);
    }
```

In `main.rs`, after the `cap` read:

```rust
    let scroll_ttl_secs = std::env::var("TILECACHE_SCROLL_TTL_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(0i64);
```

and extend the `Knobs` build:

```rust
    let knobs = Knobs { cap_bytes: cap, scroll_ttl_secs, allow_private_egress: allow_private, ..Default::default() };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container && cargo test -p binnacle-tilecache config_sets_the_live_scroll_ttl`
Expected: PASS. Then `cargo build -p binnacle-tilecache` to confirm `main.rs` compiles.

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/state.rs container/tilecache/src/routes.rs container/tilecache/src/main.rs
git commit -m "feat(tilecache): live scroll TTL field seeded from env and set via config"
```

### Task A5: Dedicated live-TTL route and clear-scroll route

**Files:**
- Modify: `container/tilecache/src/routes.rs` (`app` router around line 20, add two handlers)
- Test: `container/tilecache/src/routes.rs` (tests module)

**Interfaces:**
- Produces:
  - `POST /cache/scroll-ttl` with body `{ "ttlSecs": <i64> }` sets `live_scroll_ttl_secs` and returns 204. This is the live-edit seam (no allowlist or style churn).
  - `POST /cache/clear-scroll` runs `clear_unpinned` and returns `{ "freedBytes": <i64>, "freedRows": <i64> }`.

- [ ] **Step 1: Write the failing tests**

Add to the `routes.rs` tests module:

```rust
    #[tokio::test]
    async fn scroll_ttl_route_sets_the_live_ttl_and_sweep_uses_it() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        // Two unpinned scroll rows with old last_access.
        state.cache.put("s", 0, 0, 0, &crate::cache::CachedTile {
            content_type: "image/png".into(), strong_etag: "e".into(), upstream_validator: None,
            status: 200, fetched_at: 0, last_access: 0, bytes: 10, blob: Some(bytes::Bytes::from(vec![0u8; 10])),
        }, false, 0).unwrap();
        let router = app(state.clone());
        // Set a 1-second TTL via the dedicated route.
        let set = router.clone().oneshot(
            Request::post("/cache/scroll-ttl").header("content-type", "application/json")
                .body(Body::from(r#"{"ttlSecs":1}"#)).unwrap()
        ).await.unwrap();
        assert_eq!(set.status(), StatusCode::NO_CONTENT);
        assert_eq!(state.live_scroll_ttl_secs.load(std::sync::atomic::Ordering::Relaxed), 1);
        // A sweep at a far-future now removes the old row.
        let (freed, rows) = state.cache.sweep_aged_unpinned(state.live_scroll_ttl_secs.load(std::sync::atomic::Ordering::Relaxed), 1_000_000).unwrap();
        assert_eq!((freed, rows), (10, 1));
    }

    #[tokio::test]
    async fn clear_scroll_route_reports_freed_and_keeps_pinned() {
        let db = NamedTempFile::new().unwrap();
        let state = dev_state(&db);
        state.cache.put("s", 0, 0, 0, &crate::cache::CachedTile {
            content_type: "image/png".into(), strong_etag: "e".into(), upstream_validator: None,
            status: 200, fetched_at: 0, last_access: 0, bytes: 25, blob: Some(bytes::Bytes::from(vec![0u8; 25])),
        }, false, 0).unwrap();
        let router = app(state.clone());
        let resp = router.oneshot(Request::post("/cache/clear-scroll").body(Body::empty()).unwrap()).await.unwrap();
        let (status, body) = body_string(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"freedBytes\":25"), "reports the freed bytes");
        assert!(body.contains("\"freedRows\":1"), "reports the freed rows");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container && cargo test -p binnacle-tilecache scroll_ttl_route clear_scroll_route`
Expected: FAIL (routes not defined).

- [ ] **Step 3: Add the routes and handlers**

In `app`, add two routes after `.route("/config", post(config))`:

```rust
        .route("/cache/scroll-ttl", post(set_scroll_ttl))
        .route("/cache/clear-scroll", post(clear_scroll))
```

Add the handlers (near `config`):

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollTtlBody {
    ttl_secs: i64,
}

/// POST /cache/scroll-ttl: set only the live scroll TTL. A dedicated route so a live TTL edit does
/// not re-push the source allowlist or clear the learned style state, which POST /config does.
async fn set_scroll_ttl(State(st): State<AppState>, Json(body): Json<ScrollTtlBody>) -> StatusCode {
    st.live_scroll_ttl_secs.store(body.ttl_secs, Ordering::Relaxed);
    StatusCode::NO_CONTENT
}

/// POST /cache/clear-scroll: delete every unpinned scroll tile, keeping pinned region and
/// position-warm tiles. Runs on a blocking thread because the chunked delete is synchronous.
async fn clear_scroll(State(st): State<AppState>) -> Response {
    let cache = st.cache.clone();
    match tokio::task::spawn_blocking(move || cache.clear_unpinned()).await {
        Ok(Ok((bytes, rows))) => Json(serde_json::json!({ "freedBytes": bytes, "freedRows": rows })).into_response(),
        Ok(Err(e)) => {
            eprintln!("tilecache: clear_unpinned failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            eprintln!("tilecache: clear_unpinned task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container && cargo test -p binnacle-tilecache scroll_ttl_route clear_scroll_route`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/routes.rs
git commit -m "feat(tilecache): add the live scroll-ttl and clear-scroll routes"
```

### Task A6: The sweep scheduler task

**Files:**
- Create: `container/tilecache/src/sweep.rs`
- Modify: `container/tilecache/src/lib.rs` (add `pub mod sweep;`)
- Modify: `container/tilecache/src/main.rs` (spawn the sweeper before `axum::serve`)
- Test: `container/tilecache/src/sweep.rs` (unit test of `run_sweep_once`)

**Interfaces:**
- Consumes: `AppState.cache`, `AppState.live_scroll_ttl_secs`, `crate::state::now_secs`, `TileCache::sweep_aged_unpinned`.
- Produces: `pub async fn run_sweeper(state: AppState)` (loops on a tokio interval, immediate first tick is the startup sweep) and `pub async fn run_sweep_once(state: &AppState)` (logs on error, never panics).

- [ ] **Step 1: Write the failing test**

Create `container/tilecache/src/sweep.rs` with a test that drives `run_sweep_once` against a state holding an old unpinned row and a 1-second TTL:

```rust
//! The background scroll-tile TTL sweeper: an interval task whose immediate first tick is the startup
//! sweep, then a fixed period. It logs on error and never panics, so a transient SQLite error cannot
//! end the interval or wedge the TTL until the next container restart.

use crate::state::{now_secs, AppState};
use std::sync::atomic::Ordering;
use std::time::Duration;

/// The sweep period. The TTL window is the user knob; this cadence is fixed. It stays well above the
/// last_access touch throttle (an hour), so the minimum useful TTL is one day.
const SWEEP_INTERVAL_SECS: u64 = 3600;

/// Run one sweep, off the async runtime thread, logging the outcome. Never panics.
pub async fn run_sweep_once(state: &AppState) {
    let ttl = state.live_scroll_ttl_secs.load(Ordering::Relaxed);
    let now = now_secs();
    let cache = state.cache.clone();
    match tokio::task::spawn_blocking(move || cache.sweep_aged_unpinned(ttl, now)).await {
        Ok(Ok((bytes, rows))) => {
            if rows > 0 {
                eprintln!("tilecache: scroll TTL swept {rows} tiles, {bytes} bytes");
            }
        }
        Ok(Err(e)) => eprintln!("tilecache: scroll TTL sweep failed: {e}"),
        Err(e) => eprintln!("tilecache: scroll TTL sweep task failed: {e}"),
    }
}

/// The interval loop. The first `tick()` returns immediately, so it is the startup sweep.
pub async fn run_sweeper(state: AppState) {
    let mut ticker = tokio::time::interval(Duration::from_secs(SWEEP_INTERVAL_SECS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        run_sweep_once(&state).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{CachedTile, TileCache};
    use crate::state::Knobs;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    fn scroll_tile(bytes: i64, last_access: i64) -> CachedTile {
        CachedTile {
            content_type: "image/png".into(),
            strong_etag: "e".into(),
            upstream_validator: None,
            status: 200,
            fetched_at: 0,
            last_access,
            bytes,
            blob: Some(bytes::Bytes::from(vec![0u8; bytes as usize])),
        }
    }

    #[tokio::test]
    async fn run_sweep_once_evicts_aged_unpinned_when_ttl_is_set() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        cache.put("s", 0, 0, 0, &scroll_tile(10, 0), false, 0).unwrap();
        let knobs = Knobs { scroll_ttl_secs: 1, ..Default::default() };
        let state = AppState::new(cache.clone(), knobs);
        run_sweep_once(&state).await;
        assert!(cache.get("s", 0, 0, 0).unwrap().is_none(), "the aged unpinned tile is swept");
    }

    #[tokio::test]
    async fn run_sweep_once_is_a_no_op_when_ttl_is_zero() {
        let db = NamedTempFile::new().unwrap();
        let cache = Arc::new(TileCache::open(db.path()).unwrap());
        cache.put("s", 0, 0, 0, &scroll_tile(10, 0), false, 0).unwrap();
        let state = AppState::new(cache.clone(), Knobs::default());
        run_sweep_once(&state).await;
        assert!(cache.get("s", 0, 0, 0).unwrap().is_some(), "ttl 0 leaves the tile in place");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd container && cargo test -p binnacle-tilecache run_sweep_once`
Expected: FAIL (module not declared).

- [ ] **Step 3: Declare the module and spawn the sweeper**

In `container/tilecache/src/lib.rs`, add `pub mod sweep;` with the other module declarations.

In `main.rs`, after `let state = AppState::new(cache, knobs);` and before binding the listener:

```rust
    tokio::spawn(binnacle_tilecache::sweep::run_sweeper(state.clone()));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd container && cargo test -p binnacle-tilecache run_sweep_once` then `cargo build -p binnacle-tilecache`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add container/tilecache/src/sweep.rs container/tilecache/src/lib.rs container/tilecache/src/main.rs
git commit -m "feat(tilecache): run the scroll TTL sweep at startup and on an interval"
```

### Task A7: Rust gate

- [ ] **Step 1: Run the full Rust gate**

Run:
```bash
cd container && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo build --release --bin tilecache
```
Expected: all tests pass, clippy clean, release builds.

- [ ] **Step 2: Commit any clippy fixes**

```bash
git add -A
git commit -m "chore(tilecache): satisfy clippy for the scroll TTL and clear paths"
```
(Skip if there was nothing to fix.)

---

## Unit B: Node plugin (`src/`)

### Task B1: Store cacheScrollTtlDays in the regions-store

**Files:**
- Modify: `src/runtime/regions-store.ts` (`RegionsStore` around line 35, `DEFAULT_REGIONS_STORE` around line 41, `loadRegionsStore` around line 111, `migrateV2` around line 101)
- Modify: `test/position-warmer.test.ts` (the `store()` helper literal, around line 11) and `test/regions-store.test.ts` (the inline `store` literal, around line 42), to add the new required field
- Test: `test/regions-store.test.ts` (existing) or a new `test/regions-store-ttl.test.ts`

**Interfaces:**
- Produces: `RegionsStore.cacheScrollTtlDays: number` defaulting to 30, persisted and loaded with a default fallback.

- [ ] **Step 1: Write the failing test**

Add a test (match the existing regions-store test file's imports and style):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegionsStore, saveRegionsStore, DEFAULT_REGIONS_STORE } from '../src/runtime/regions-store.js'

test('the regions store defaults cacheScrollTtlDays to 30', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-ttl-'))
  assert.equal(loadRegionsStore(dir).cacheScrollTtlDays, 30)
})

test('cacheScrollTtlDays round-trips through save and load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-ttl-'))
  saveRegionsStore(dir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 7 })
  assert.equal(loadRegionsStore(dir).cacheScrollTtlDays, 7)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="cacheScrollTtlDays"` (or run the whole suite; the new assertions fail).
Expected: FAIL (`cacheScrollTtlDays` is undefined).

- [ ] **Step 3: Add the field**

In `RegionsStore`:

```ts
  cacheScrollTtlDays: number
```

In `DEFAULT_REGIONS_STORE`, add (top level, not inside positionWarm):

```ts
  cacheScrollTtlDays: 30,
```

In `loadRegionsStore`, read it with a default, in BOTH return paths (the normal return and via `migrateV2`). For the normal path, change the final return to include:

```ts
  const rawTtl = typeof parsed['cacheScrollTtlDays'] === 'number' ? parsed['cacheScrollTtlDays'] : DEFAULT_REGIONS_STORE.cacheScrollTtlDays
  return {
    regions: rawRegions,
    positionWarm: { ...DEFAULT_REGIONS_STORE.positionWarm, ...rawPositionWarm },
    cacheScrollTtlDays: rawTtl
  }
```

In `migrateV2`, add `cacheScrollTtlDays` to the constructed `store` from `raw['cacheScrollTtlDays']` with the same default fallback:

```ts
  const rawTtl = typeof raw['cacheScrollTtlDays'] === 'number' ? raw['cacheScrollTtlDays'] : DEFAULT_REGIONS_STORE.cacheScrollTtlDays
  const store: RegionsStore = {
    regions,
    positionWarm: { ...DEFAULT_REGIONS_STORE.positionWarm, ...rawPositionWarm },
    cacheScrollTtlDays: rawTtl
  }
```

- [ ] **Step 3b: Fix the two existing RegionsStore literals the new required field breaks**

Making `cacheScrollTtlDays` required breaks two existing test literals that omit it, which would fail the B5 typecheck. Add the field to both:

In `test/position-warmer.test.ts`, the `store()` helper (around line 11):

```ts
function store (over: Partial<typeof DEFAULT_REGIONS_STORE.positionWarm> = {}): RegionsStore {
  return {
    regions: [region([-123, 37, -122, 38])],
    positionWarm: { ...DEFAULT_REGIONS_STORE.positionWarm, enabled: true, sources: ['seamark'], ...over },
    cacheScrollTtlDays: 30
  }
}
```

In `test/regions-store.test.ts`, the inline `store` literal (around line 42):

```ts
  const store: RegionsStore = {
    regions: [region],
    positionWarm: { enabled: true, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: ['seamark'] },
    cacheScrollTtlDays: 30
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS (the whole suite plus the typecheck, confirming the existing literals still compile with the new required field).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/regions-store.ts test/
git commit -m "feat(plugin): persist the scroll cache TTL days in the regions store"
```

### Task B2: Carry scrollTtlSecs in the config payload and container env

**Files:**
- Modify: `src/runtime/tilecache-config-push.ts` (`TilecacheConfigPayload` around line 9, `buildSourcePayload` around line 27)
- Modify: `src/runtime/tilecache-container.ts` (`TilecacheContainerOptions` around line 32, `buildTilecacheConfig` env around line 51)
- Test: `test/tilecache-config-push.test.ts` and `test/tilecache-container.test.ts` (existing or new)

**Interfaces:**
- Produces: `TilecacheConfigPayload.scrollTtlSecs: number`; `buildSourcePayload(capBytes, regionsBudgetBytes, positionWarmBudgetBytes, scrollTtlSecs, publicBase?)`. `TilecacheContainerOptions.scrollTtlSecs?: number`; `buildTilecacheConfig` sets `TILECACHE_SCROLL_TTL_SECS` in the env.

- [ ] **Step 1: Write the failing tests**

```ts
// in the config-push test file
test('buildSourcePayload carries scrollTtlSecs', () => {
  const payload = buildSourcePayload(100, 50, 5, 86_400)
  assert.equal(payload.scrollTtlSecs, 86_400)
})

// in the container test file
test('buildTilecacheConfig sets the scroll TTL env in seconds', () => {
  const config = buildTilecacheConfig({ capBytes: 1024, scrollTtlSecs: 2_592_000 })
  assert.equal(config.env?.TILECACHE_SCROLL_TTL_SECS, '2592000')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Add the field and the env**

In `tilecache-config-push.ts`, add `scrollTtlSecs: number` to `TilecacheConfigPayload`, and update `buildSourcePayload`:

```ts
export function buildSourcePayload (
  capBytes: number,
  regionsBudgetBytes: number,
  positionWarmBudgetBytes: number,
  scrollTtlSecs: number,
  publicBase: string = PLUGIN_PUBLIC_BASE
): TilecacheConfigPayload {
  return { sources: CHART_SOURCES, publicBase, capBytes, regionsBudgetBytes, positionWarmBudgetBytes, scrollTtlSecs }
}
```

In `tilecache-container.ts`, add `scrollTtlSecs?: number` to `TilecacheContainerOptions`, and in `buildTilecacheConfig` add to the `env` object:

```ts
      TILECACHE_SCROLL_TTL_SECS: String(opts.scrollTtlSecs ?? 0)
```

- [ ] **Step 3b: Update the existing three-arg buildSourcePayload callers**

Making `scrollTtlSecs` a required fourth positional argument (before the optional `publicBase`) breaks three existing callers in `test/tilecache-config-push.test.ts` at lines 7, 20, and 33, which would fail the B5 typecheck. Add a fourth argument to each. Line 7:

```ts
  const payload = buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0)
```

Lines 20 and 33 (inside the `pushTilecacheConfig(...)` calls):

```ts
  ... await pushTilecacheConfig('addr:8080', buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0), ...)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS (the suite plus the typecheck, confirming the updated callers compile).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/tilecache-config-push.ts src/runtime/tilecache-container.ts test/
git commit -m "feat(plugin): carry the scroll TTL seconds into the container env and config"
```

### Task B3: Wire the TTL into doStart

**Files:**
- Modify: `src/plugin/plugin.ts` (`doStart`, around lines 95 through 133)

**Interfaces:**
- Consumes: `loadRegionsStore`, `buildTilecacheConfig`, `buildSourcePayload` (now four-arg).
- Produces: the container is launched with `scrollTtlSecs` and the start `/config` push carries it; the store is read before either is built.

- [ ] **Step 1: Read the store TTL early and thread it through**

At the top of the `try` block in `doStart`, before `buildTilecacheConfig`, read the TTL once (the store is the source of truth; `loadRegionsStore` is cheap and pure):

```ts
      // loadRegionsStore always returns cacheScrollTtlDays (default 30 from the store loader), so no
      // fallback is needed here; clamp and convert days to seconds at this edge.
      const scrollTtlSecs = Math.max(0, Math.round(loadRegionsStore(app.getDataDirPath()).cacheScrollTtlDays * 86_400))
```

Pass it into the container options:

```ts
      const tilecacheConfig = buildTilecacheConfig({
        tag: config?.tilecacheImageTag?.trim() || undefined,
        capBytes,
        scrollTtlSecs,
        ...(config?.tilecacheCacheVolumeSource?.trim() ? { externalCacheVolumeSource: config.tilecacheCacheVolumeSource.trim() } : {})
      })
```

and into the start push (now four-arg):

```ts
        const pushed = await pushTilecacheConfig(tcAddress, buildSourcePayload(capBytes, regionsBudgetBytes, pBudget, scrollTtlSecs))
```

- [ ] **Step 2: Type-check and build**

Run: `npm run typecheck && npm run build`
Expected: clean (the four-arg `buildSourcePayload` and the new option type-check).

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS (no regressions; if a `doStart` integration test asserts the payload, update it to the four-arg form).

- [ ] **Step 4: Commit**

```bash
git add src/plugin/plugin.ts
git commit -m "feat(plugin): seed the container scroll TTL from the regions store on start"
```

### Task B4: The cache routes

**Files:**
- Modify: `src/http/regions-routes.ts` (add three route handlers near the existing `/api/cache/stats` at line 158)
- Create: `test/cache-routes.test.ts` (new, following the `test/regions-crud.test.ts` harness: `makeRouter`, `fakeRes`, `fakeApp`, a recording `fetchImpl` passed through `deps`)

**Interfaces:**
- Consumes: `loadRegionsStore`, `saveRegionsStore`, `withAddress`, `relay`, `fetchImpl`, `warmInit`.
- Produces:
  - `POST /api/cache/config { ttlDays }`: validate integer 0 through 365, save it to the store, POST `{ ttlSecs }` to the container `/cache/scroll-ttl`, return 204; a bad value returns 400 and never touches the container.
  - `POST /api/cache/clear-scroll`: relay the container `/cache/clear-scroll`, returning its `{ freedBytes, freedRows }`.
  - `GET /api/cache/stats` (replace the existing `relay`): fetch the container stats, parse, add `ttlDays` from the store, send the merged object; `bySource` passes through.

- [ ] **Step 1: Write the failing tests**

Create `test/cache-routes.test.ts` following the exact harness in `test/regions-crud.test.ts`: `makeRouter()` returns `{ routes, router }`, `fakeRes()` returns `{ responded, res }` where each entry is `{ status, body }`, `fakeApp()` from `./helpers.js` provides the app, and a recording `fetchImpl` is passed through `deps`. The container is addressed by passing `() => '127.0.0.1:9999'`. Find a handler with `routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')`.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerAPI } from '@signalk/server-api'
import { registerRegionsRoutes, type RegionsRouter, type RegionsResponse } from '../src/http/regions-routes.js'
import { loadRegionsStore, saveRegionsStore, DEFAULT_REGIONS_STORE } from '../src/runtime/regions-store.js'
import { fakeApp } from './helpers.js'

const app = (): ServerAPI => fakeApp() as unknown as ServerAPI

function makeRouter () {
  const routes: Array<{ method: string; path: string; handler: Function }> = []
  const router: RegionsRouter = {
    get (path, handler) { routes.push({ method: 'GET', path, handler }) },
    post (path, handler) { routes.push({ method: 'POST', path, handler }) },
    delete (path, handler) { routes.push({ method: 'DELETE', path, handler }) }
  }
  return { routes, router }
}

function fakeRes (): { responded: Array<{ status: number; body: unknown }>; res: RegionsResponse } {
  const responded: Array<{ status: number; body: unknown }> = []
  const res: RegionsResponse = {
    status (code) { responded.push({ status: code, body: null }); return res },
    json (body) { if (responded.length) responded[responded.length - 1].body = body },
    end () { if (responded.length) responded[responded.length - 1].body = null }
  }
  return { responded, res }
}

/** A recording fetch that returns canned container responses keyed by URL suffix. */
function recordingFetch (responses: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
    calls.push({ url, init })
    const key = Object.keys(responses).find((k) => url.endsWith(k))
    const r = key ? responses[key] : { status: 200, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

test('POST /api/cache/config rejects a non-integer, a negative, and an over-range ttlDays', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { calls, fetchImpl } = recordingFetch({})
  const { router, routes } = makeRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')!
  for (const bad of [3.5, -1, 366, 'x']) {
    const { responded, res } = fakeRes()
    await route.handler({ params: {}, body: { ttlDays: bad } }, res)
    assert.equal(responded[0]?.status, 400, `ttlDays ${String(bad)} must be rejected`)
  }
  assert.equal(calls.filter((c) => c.url.endsWith('/cache/scroll-ttl')).length, 0, 'no container call on a bad value')
})

test('POST /api/cache/config saves the store and posts ttlSecs to the container', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { calls, fetchImpl } = recordingFetch({ '/cache/scroll-ttl': { status: 204, body: {} } })
  const { router, routes } = makeRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')!
  const { responded, res } = fakeRes()
  await route.handler({ params: {}, body: { ttlDays: 7 } }, res)
  assert.equal(responded[0]?.status, 204)
  assert.equal(loadRegionsStore(dataDir).cacheScrollTtlDays, 7)
  const call = calls.find((c) => c.url.endsWith('/cache/scroll-ttl'))
  assert.ok(call, 'posted to the container scroll-ttl route')
  assert.deepEqual(JSON.parse(call!.init!.body!), { ttlSecs: 7 * 86_400 })
})

test('POST /api/cache/clear-scroll relays the freed totals', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { fetchImpl } = recordingFetch({ '/cache/clear-scroll': { status: 200, body: { freedBytes: 123, freedRows: 4 } } })
  const { router, routes } = makeRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/clear-scroll')!
  const { responded, res } = fakeRes()
  await route.handler({ params: {}, body: {} }, res)
  assert.equal(responded[0]?.status, 200)
  assert.deepEqual(responded[0]?.body, { freedBytes: 123, freedRows: 4 })
})

test('GET /api/cache/stats merges ttlDays from the store and passes bySource through', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  saveRegionsStore(dataDir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 14 })
  const { fetchImpl } = recordingFetch({ '/cache/stats': { status: 200, body: { rows: 1, bytes: 2, cap: 3, bySource: [{ source: 's', bytes: 2, rows: 1 }], perSourceAvgBytes: {} } } })
  const { router, routes } = makeRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'GET' && r.path === '/api/cache/stats')!
  const { responded, res } = fakeRes()
  await route.handler({ params: {}, body: null }, res)
  assert.equal(responded[0]?.status, 200)
  const body = responded[0]?.body as { ttlDays?: number; bySource?: unknown }
  assert.equal(body.ttlDays, 14)
  assert.deepEqual(body.bySource, [{ source: 's', bytes: 2, rows: 1 }])
})
```

Note: this test depends on Task B1 (the `DEFAULT_REGIONS_STORE.cacheScrollTtlDays` field), so run B1 first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (routes not defined).

- [ ] **Step 3: Add the routes**

In `registerRegionsRoutes`, replace the existing `GET /api/cache/stats` handler and add the two POST routes. Place them next to the current stats route:

```ts
  router.post('/api/cache/config', async (req, res) => {
    const ttlDays = (req.body as { ttlDays?: unknown } | undefined)?.ttlDays
    if (typeof ttlDays !== 'number' || !Number.isInteger(ttlDays) || ttlDays < 0 || ttlDays > 365) {
      res.status(400).json({ error: 'ttlDays must be an integer between 0 and 365' }); return
    }
    // Persist to the store first, the source of truth, so the new TTL survives even when the container
    // is down: it is pushed on the next doStart. With no address this returns 503 after persisting,
    // which is intended.
    const store = loadRegionsStore(dataDir)
    saveRegionsStore(dataDir, { ...store, cacheScrollTtlDays: ttlDays })
    const address = withAddress(res); if (address === null) return
    try {
      await fetchImpl(`http://${address}/cache/scroll-ttl`, warmInit({ ttlSecs: ttlDays * 86_400 }))
      res.status(204).end()
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })

  router.post('/api/cache/clear-scroll', async (_req, res) => {
    const address = withAddress(res); if (address === null) return
    return relay(res, fetchImpl(`http://${address}/cache/clear-scroll`, { method: 'POST' }))
  })

  router.get('/api/cache/stats', async (_req, res) => {
    const address = withAddress(res); if (address === null) return
    // Not a pure relay: the container stats are merged with ttlDays from the store (the plugin owns the
    // TTL persistence), so the panel reads the TTL and the cache breakdown in one round-trip.
    try {
      const r = await fetchImpl(`http://${address}/cache/stats`)
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
      const ttlDays = loadRegionsStore(dataDir).cacheScrollTtlDays
      res.status(r.status).json({ ...body, ttlDays })
    } catch {
      res.status(502).json({ error: 'tilecache unreachable' })
    }
  })
```

Note: the `warmInit` helper already sets the POST method, the JSON content-type, and the serialized body, so it is reused for the scroll-ttl post. The clear-scroll relay sends a bodyless POST.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/regions-routes.ts test/
git commit -m "feat(plugin): add the cache config, clear-scroll, and merged-stats routes"
```

### Task B5: Plugin gate

- [ ] **Step 1: Run the full plugin gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 2: Commit any lint fixes**

```bash
git add -A
git commit -m "chore(plugin): satisfy lint for the cache routes"
```
(Skip if nothing to fix.)

---

## Unit C: Webapp panel (`signalk-binnacle`, `src/features/prewarm/`)

All paths in this unit are in the `signalk-binnacle` repo at `/home/dietpi/src/signalk-binnacle`.

### Task C1: Client calls and CacheStats fields

**Files:**
- Modify: `src/features/prewarm/regions-client.ts` (`CacheStats` around line 18, `RegionsClient` around line 55, the returned object around line 80)
- Test: `src/features/prewarm/regions-client.test.ts`

**Interfaces:**
- Produces: `CacheStats` gains `bySource?: { source: string; bytes: number; rows: number }[]` and `ttlDays?: number` (both optional, matching the existing optional two-budget fields). `RegionsClient` gains `setCacheConfig(ttlDays: number): Promise<void>` (POST `/cache/config`) and `clearScrollCache(): Promise<{ freedBytes: number; freedRows: number }>` (POST `/cache/clear-scroll`).

- [ ] **Step 1: Write the failing tests**

Match the existing `regions-client.test.ts` style (it builds a client with a `fetchImpl` stub and asserts the URL and init). Add:

```ts
it('setCacheConfig posts ttlDays to the cache config route', async () => {
  const fetchImpl = vi.fn(async () => ok(undefined));
  const client = createRegionsClient('http://h/plugins/signalk-chart-locker', 'tok', fetchImpl as unknown as typeof fetch);
  await client.setCacheConfig(14);
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://h/plugins/signalk-chart-locker/api/cache/config',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ ttlDays: 14 }) }),
  );
});

it('clearScrollCache posts to the clear route and returns the freed totals', async () => {
  const fetchImpl = vi.fn(async () => ok({ freedBytes: 9, freedRows: 2 }));
  const client = createRegionsClient('http://h/plugins/signalk-chart-locker', 'tok', fetchImpl as unknown as typeof fetch);
  const out = await client.clearScrollCache();
  expect(out).toEqual({ freedBytes: 9, freedRows: 2 });
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://h/plugins/signalk-chart-locker/api/cache/clear-scroll',
    expect.objectContaining({ method: 'POST' }),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- regions-client`
Expected: FAIL (methods not defined).

- [ ] **Step 3: Add the fields and the methods**

In `CacheStats`, add:

```ts
  bySource?: { source: string; bytes: number; rows: number }[];
  ttlDays?: number;
```

In the `RegionsClient` interface, add:

```ts
  setCacheConfig(ttlDays: number): Promise<void>;
  clearScrollCache(): Promise<{ freedBytes: number; freedRows: number }>;
```

In the returned object (next to `getCacheStats`):

```ts
    async setCacheConfig(ttlDays) {
      await fetchImpl(url('/cache/config'), jsonPost({ ttlDays }));
    },
    async clearScrollCache() {
      return json<{ freedBytes: number; freedRows: number }>(
        await fetchImpl(url('/cache/clear-scroll'), authInit(token, { method: 'POST' })),
      );
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- regions-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/prewarm/regions-client.ts
git commit -m "feat(regions): add the cache config and clear-scroll client calls"
```

### Task C2: The Scroll cache panel section

**Files:**
- Modify: `src/features/prewarm/estimate.ts` (add a pure `formatBySource` helper after `formatBytes`, around line 89)
- Modify: `src/features/prewarm/estimate.test.ts` (add a `formatBySource` test alongside the existing pure-helper tests)
- Modify: `src/features/prewarm/RegionsPanel.svelte` (script: state and handlers near the existing stats handlers; template: a new section between the Saved regions block ending around line 642 and the `Position warm` heading at line 644)

There is no Svelte render harness in this feature: `regions-panel.svelte.test.ts` never mounts the component, it only unit-tests pure helpers. So the new per-source formatting is extracted into `estimate.ts` and unit-tested there, and the panel template calls that helper. The rest of the section (the TTL `UnitField` and the clear `InlineConfirm`) is verified manually in the app.

**Interfaces:**
- Consumes: `client.setCacheConfig`, `client.clearScrollCache`, `stats.bytes`, `stats.cap`, `stats.ttlDays`, `formatBytes`, `formatBySource`, `UnitField`, `InlineConfirm`.
- Produces: a pure `formatBySource(stats: CacheStats): Array<{ source: string; value: string; unit: string }>` in `estimate.ts`, and a "Scroll cache" section with a used-against-cap line, a per-source list, a TTL `UnitField`, and a clear button behind `InlineConfirm`.

- [ ] **Step 1: Write the failing test**

Add to `src/features/prewarm/estimate.test.ts` (match the existing `describe`/`it` and import style):

```ts
import { formatBySource } from './estimate.js';
import type { CacheStats } from './regions-client.js';

describe('formatBySource', () => {
  it('formats each scroll source and returns an empty list when bySource is absent', () => {
    const base = { rows: 0, bytes: 0, cap: 0, perSourceAvgBytes: {} } as CacheStats;
    expect(formatBySource(base)).toEqual([]);
    const withSources = { ...base, bySource: [{ source: 'seamark', bytes: 1024, rows: 3 }] } as CacheStats;
    const out = formatBySource(withSources);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('seamark');
    expect(typeof out[0].value).toBe('string');
    expect(typeof out[0].unit).toBe('string');
  });
});
```

(If `estimate.test.ts` already imports `formatBytes` or `CacheStats`, fold these imports into the existing import lines rather than duplicating them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- estimate`
Expected: FAIL (`formatBySource` is not exported).

- [ ] **Step 3: Add the formatBySource helper, the import, and the script state and handlers**

In `src/features/prewarm/estimate.ts`, after `formatBytes` (around line 89), add the pure helper:

```ts
/** Format the per-source scroll totals for the cache-management breakdown: each source's bytes through
 * formatBytes, so the panel renders them with the same value-and-unit shape as every other stat. An
 * absent bySource yields an empty list. */
export function formatBySource(stats: CacheStats): Array<{ source: string; value: string; unit: string }> {
  return (stats.bySource ?? []).map((row) => {
    const b = formatBytes(row.bytes);
    return { source: row.source, value: b.value, unit: b.unit };
  });
}
```

In `RegionsPanel.svelte`, add `formatBySource` to the existing import from `./estimate.js` (the import block at lines 9 through 17):

```ts
import {
  canDownloadRegion,
  coveringSources,
  estimateBytes,
  formatBySource,
  formatBytes,
  isTerminal,
  regionSources,
  regionsFreeBytes,
} from './estimate.js';
```

In the `<script>` block, add state near the other stats state (around line 56):

```ts
// The scroll cache TTL in days, seeded from stats.ttlDays on load. Zero means the age sweep is off.
let ttlDays = $state(30);
// Clearing the scroll cache arms an inline confirm first, like every destructive action in the app.
let confirmingClear = $state(false);
let clearNote = $state<string | null>(null);
```

In `loadStats`, after `stats = s;`, seed the control from the server value:

```ts
    if (typeof s.ttlDays === 'number') ttlDays = s.ttlDays;
```

Add the two handlers near `savePositionWarm` (reuse the write-blocked guard pattern):

```ts
function commitTtlDays(entered: number): void {
  if (auth.writeBlocked) return;
  ttlDays = Math.round(Math.max(0, Math.min(entered, 365)));
  void client.setCacheConfig(ttlDays).catch(() => {});
}

async function clearScrollCache(): Promise<void> {
  if (auth.writeBlocked) return;
  confirmingClear = false;
  clearNote = null;
  try {
    const { freedBytes } = await client.clearScrollCache();
    const f = formatBytes(freedBytes);
    clearNote = freedBytes > 0 ? `Cleared ${f.value} ${f.unit} of scroll cache.` : 'Nothing to clear.';
    await loadStats();
  } catch {
    error = 'Could not clear the scroll cache.';
  }
}
```

Add a derived for the used-against-cap line near the other derived formatters (around line 134):

```ts
const usedFmt = $derived(stats !== null ? formatBytes(stats.bytes) : null);
const capFmt = $derived(stats !== null ? formatBytes(stats.cap) : null);
```

- [ ] **Step 4: Add the template section**

Between the end of the Saved regions block (after the closing of the `{:else}` that renders `SavedList`, around line 642) and `<h3 class="caps-label section-head">Position warm</h3>` (line 644), insert:

```svelte
  <h3 class="caps-label section-head">Scroll cache</h3>
  {#if stats !== null}
    <dl class="stat-grid">
      <dt>Cache used</dt>
      <dd>
        <span class="num">{usedFmt?.value ?? '--'}</span>
        <span class="unit">{usedFmt?.unit ?? ''}</span>
      </dd>
      <dt>Cache cap</dt>
      <dd>
        <span class="num">{capFmt?.value ?? '--'}</span>
        <span class="unit">{capFmt?.unit ?? ''}</span>
      </dd>
      {#each formatBySource(stats) as row (row.source)}
        <dt>{row.source}</dt>
        <dd><span class="num">{row.value}</span> <span class="unit">{row.unit}</span></dd>
      {/each}
    </dl>
  {/if}
  <UnitField
    label="Scroll cache age limit"
    unit="days"
    value={ttlDays}
    min={0}
    max={365}
    step={1}
    onCommit={commitTtlDays}
  />
  {#if confirmingClear}
    <InlineConfirm
      question="Clear all unpinned scroll tiles?"
      onConfirm={() => void clearScrollCache()}
      onCancel={() => (confirmingClear = false)}
    />
  {:else}
    <div class="panel-controls">
      <button
        type="button"
        class="btn btn-ghost"
        disabled={auth.writeBlocked}
        onclick={() => (confirmingClear = true)}
      >
        <Trash2 size={16} aria-hidden="true" />
        Clear scroll cache
      </button>
    </div>
  {/if}
  {#if clearNote !== null}
    <p class="muted-note">{clearNote}</p>
  {/if}
```

(`Trash2` is already imported at line 2; no new import.)

- [ ] **Step 5: Run the helper test and check the build**

Run: `npm test -- estimate && npm run check`
Expected: PASS (the `formatBySource` test and svelte-check). Manually confirm the section in the app: the TTL field commits, and the clear button arms the inline confirm.

- [ ] **Step 6: Commit**

```bash
git add src/features/prewarm/RegionsPanel.svelte src/features/prewarm/estimate.ts src/features/prewarm/estimate.test.ts
git commit -m "feat(regions): add the scroll cache breakdown, TTL control, and clear action"
```

### Task C3: Webapp gate

- [ ] **Step 1: Run the full webapp gate**

Run: `npm test && npm run check && npm run ci:biome`
Expected: all green. If `ci:biome` flags formatting, run `npm run format` then `npx biome check --write` on the touched files and re-run.

- [ ] **Step 2: Commit any formatting fixes**

```bash
git add -A
git commit -m "style(regions): biome formatting for the scroll cache section"
```
(Skip if nothing to fix.)

---

## Self-Review

**Spec coverage:**
- Age sweep of unpinned by last_access, pinned exempt, ttl 0 disables: Task A2, A6.
- Chunked delete, total_bytes decrement, pinned_bytes unchanged: Task A2.
- Partial index: Task A1.
- Per-source totals (scroll-only) in stats: Task A3.
- Live TTL field, env seed, start /config fold: Task A4.
- Dedicated live-TTL route and clear-scroll route: Task A5.
- Sweep scheduler (immediate first tick, MissedTickBehavior::Skip, log-not-unwrap, spawn_blocking): Task A6.
- TTL persisted in the regions-store, default 30, migration covered: Task B1.
- scrollTtlSecs in the container env and config payload: Task B2.
- doStart reads the store TTL before building config and pushes it: Task B3.
- Plugin routes (config validate 0 to 365 and save and post, clear-scroll relay, stats merge ttlDays and pass bySource), all admin-gated and fail-closed via the shared `withAddress` and the gate at `registerRegionsRoutes`: Task B4.
- Client calls and optional CacheStats fields: Task C1.
- Panel section: breakdown without duplicating Pinned and Scrolling, per-source rows, UnitField TTL, clear behind InlineConfirm, muted nothing-to-clear note: Task C2.

**Placeholder scan:** none. Every step shows the code or the exact command.

**Type consistency:** `buildSourcePayload` is four-arg in B2, called four-arg in B3, and its three existing three-arg test callers are updated in B2 Step 3b; the required `RegionsStore.cacheScrollTtlDays` added in B1 is added to the two existing test literals in B1 Step 3b; `scrollTtlSecs` is seconds in B2, B3, A4, and A5; `ttlDays` is days in B1, B4, C1, and C2 and converted at the plugin edge in B3 and B4; `setCacheConfig`/`clearScrollCache` names match across C1 and C2; `formatBySource` is defined in `estimate.ts` (C2 Step 3), tested in `estimate.test.ts` (C2 Step 1), and called in the template (C2 Step 4); `sweep_aged_unpinned`/`clear_unpinned`/`per_source_totals` names match across A2, A3, A5, and A6.

**Test harness fit:** the plugin route tests (B4) and the new file `test/cache-routes.test.ts` follow the real `test/regions-crud.test.ts` harness (`makeRouter`, `fakeRes`, `fakeApp`, a `deps.fetchImpl`), not an invented one; the webapp helper test (C2) lives in `estimate.test.ts` because there is no Svelte render harness in this feature.

## Deviation from the spec (resolved during planning)

The spec routed the live TTL edit through a re-post of `/config`. Reading the code shows `/config`'s `sources` is required and replaces the allowlist while also clearing the learned style state, so a live TTL edit cannot post a partial `/config`. The plan therefore folds `scrollTtlSecs` into the start `/config` push (no extra round-trip) and adds a dedicated `POST /cache/scroll-ttl` for the live edit only. Both review lenses pre-approved this exact split. The spec is updated to match.
