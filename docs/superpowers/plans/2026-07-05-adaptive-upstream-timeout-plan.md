# Plan: adaptive upstream timeout and retry for slow WMS upstreams (issue #3)

Date: 2026-07-05. Target: `container/tilecache` (Rust). Plugin side needs no code change
(`/api/cache/stats` at `src/http/regions-routes.ts:206` spreads the container body verbatim,
so a new stats field flows through untouched).

Reviewed 2026-07-05 by a two-agent team (correctness and trust boundary; plan quality and
codebase fit). All findings of all severities are incorporated below.

## Problem

Observed 2026-07-05: NOAA MaritimeChartService answered GetMap in about 65 seconds per tile.
The tilecache egress client has a global 20 second timeout (`state.rs:138`), so every uncached
tile fetch timed out and the chartplotter showed blank depth areas, while cached and pinned
tiles kept serving.

Two structural findings from code reading, beyond the issue text:

1. The plugin proxy bounds every container fetch at 8 seconds (`CONTAINER_FETCH_TIMEOUT_MS`,
   `src/runtime/container-fetch.ts`), and MapLibre cancels tile requests on every pan. When the
   browser or the proxy gives up, the connection to the container closes and axum drops the
   in-flight handler future, which cancels the upstream reqwest fetch mid-flight. So for a
   65 second upstream, the cache NEVER fills from scroll traffic, no matter how large the
   container-side timeout is. Raising the timeout alone fixes only warm jobs (which run inside
   the container and are not bounded by the proxy).
2. Timeouts are already not negative-cached (transport errors return `Err(())`, and only a real
   upstream 404 or 204 reaches `negative_cache`). But the error type is unit, so a timeout is
   indistinguishable from a connection refusal, and nothing adapts or retries.

## Design

### 1. Typed fetch error and timeout layering (`state.rs`, `fetcher.rs`)

Replace the unit error on the egress path with:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError { Timeout, Transport }
```

Timeout layering, explicit for every call site:

- `guarded_get` and `guarded_get_with_headers` (`state.rs`) return
  `Result<reqwest::Response, FetchError>` and gain a `timeout: Option<Duration>` parameter,
  applied as `RequestBuilder::timeout` before `send()` (a per-request timeout overrides the
  client-level total timeout). `None` means the client default applies. SSRF rejection and a
  closed semaphore map to `Transport`; `reqwest::Error::is_timeout()` maps to `Timeout`, every
  other send error to `Transport`.
- `fetch_upstream` (`fetcher.rs`) computes the adaptive timeout itself: it gains a
  `source_id: &str` parameter, reads `health.timeout_ms(source_id)`, and passes `Some(t)` down.
  Callers never pass a timeout. Everything routed through `fetch_upstream` therefore inherits
  the adaptive timeout and the retry uniformly: the scroll miss and stale-revalidation paths
  (`fetcher.rs:257,318`), the warm engine (`warm.rs:358` passes its asset cache-source id,
  `warm.rs:539` passes `source.id`), and the style glyph, sprite, and vector-tile routes
  (`style.rs:362,454,520` pass their style source id; warm synthetic sub-sources key as
  `style:{source}:{name}`). Per-key granularity is fine because the schedule is a per-source
  observation, not a shared host budget.
- Direct `guarded_get*` callers OUTSIDE `fetch_upstream` pass `None` and stay at the client
  default: `fetch_json` (`style.rs:85`, the style-document learn; its `.ok()?` keeps working
  against the new error type) and the geocode proxy (`geocode.rs:62`).
- `fetch_upstream` returns `Result<(u16, Fetched), FetchError>`. A body-read failure inside
  `read_capped` maps to `Transport` (a mid-body timeout is misclassified as `Transport`; for a
  degraded WMS the stall is before headers, so this is acceptable and documented in code).
- Remaining ripple: `warm.rs` and `style.rs` `Err(())` match arms become `Err(_)`.

### 2. Per-source upstream health tracker (new `container/tilecache/src/health.rs`)

Registered as `pub mod health;` in `lib.rs`.

```rust
pub struct UpstreamHealth { base_ms: u64, inner: std::sync::Mutex<HashMap<String, SourceHealth>> }
struct SourceHealth { streak: u32, last_timeout_at: i64 }
```

- Timeout schedule: `timeout_ms(id) = min(base << streak, 90_000)`, streak capped at 2.
  With the default base of 20 seconds: 20s, 40s, 80s.
- Base comes from a new `Knobs.upstream_base_timeout_ms: u64` with default `20_000` added to
  `Knobs` and its `Default` impl (`state.rs`); the client-level default timeout in
  `AppState::new` is built from the same knob so the two cannot diverge. Decision: the knob is
  a compile-time default, set directly by tests; it is NOT exposed on POST /config and gets no
  env var, because the escalation is automatic and the issue asks for no user tuning surface.
- `record_timeout(id, now)`: `streak = min(streak + 1, 2)`, `last_timeout_at = now`.
- `record_success(id, now)`: if `now - last_timeout_at >= 300` (5 quiet minutes), remove the
  entry (full recovery). Otherwise leave the escalated timeout sticky, so a source that needs
  65 seconds does not oscillate back to a 20 second timeout after each success.
- `is_slow(id)`: streak > 0.
- `snapshot()` returns plain data (source id, streak, current timeout ms, last_timeout_at) for
  the stats route; no serde derive on the internal struct, the route builds the JSON.
- All methods take `now: i64` from the caller (codebase idiom; unit tests stay clock-free).
- Plain `std::sync::Mutex`; every method locks and drops the guard before returning, and none
  is async, so the guard is never held across an await (stated as a safety comment in the file).
- `AppState` gains `pub upstream_health: Arc<UpstreamHealth>`.

### 3. Adaptive timeout and retry-once in `fetch_upstream`

```text
fetch_upstream(state, source_id, url, if_none_match):
  attempt = 0
  loop:
    t = health.timeout_ms(source_id)
    match guarded_get(url, if_none_match, Some(t)):
      Ok(resp)           -> health.record_success(source_id, now); read body; return
      Err(Timeout)       -> health.record_timeout(source_id, now)
                            if attempt == 1 { return Err(Timeout) }
                            attempt = 1; continue   // exactly one retry, at the escalated timeout
      Err(Transport)     -> return Err(Transport)   // refused connection is offline; retrying
                                                    // only delays serve-stale
```

`record_success` fires on ANY completed HTTP response, including a 404: a fast 404 proves the
upstream is responsive. One request that times out twice moves the streak 0 to 2, so the next
request runs at the 80 second ceiling; that fast escalation is intended given the retry.

### 4. Detached fill: the fetch survives client disconnect (`fetcher.rs`)

The load-bearing fix. One spawned fill function serves both the miss and the stale path, and
the single-flight lock moves inside it, so revalidation is now also coalesced (today it runs
outside the lock, `fetcher.rs:256-290`, and concurrent stale reads can double-fetch):

```text
get_tile (handler side):
  fresh 200 hit / fresh negative / NotModified  -> serve inline, unchanged
  stale 200, is_slow(source) && within max_stale -> tokio::spawn(fill(...)); do NOT await;
                                                    serve the stale tile immediately
                                                    (stale-while-revalidate)
  stale 200, not slow                            -> handle = tokio::spawn(fill(...));
                                                    await handle (304 refresh and outcome
                                                    behavior preserved)
  miss                                           -> handle = tokio::spawn(fill(...));
                                                    await handle

fill(state clone, owned source_id/z/x/y/url/validator/if_none_match) -> FetchOutcome:
  lock = state.inflight_lock(key); guard = lock.lock().await   // task holds the lock for the
                                                               // whole fetch and store
  re-check cache: fresh 200 -> Hit; fresh negative -> Empty    // losers coalesce here
  stale 200 present -> revalidate with upstream_validator:
      Ok(304)        -> refresh fetched_at (existing semantics)
      Ok(200)        -> store_200
      anything else  -> serve stale within max_stale_secs (404 on revalidate does NOT
                        negative-cache, matching today's behavior)
  no usable row -> plain fetch: Ok(200) -> store_200; Ok(404|204) -> negative_cache;
                   other status -> Unavailable; Err -> offline fallback (serve cached 200
                   within max_stale_secs, else Unavailable)
  state.inflight_finish(key, lock); return outcome
```

- A join error on an awaited handle logs and returns `Unavailable`.
- If the browser cancels or the plugin proxy hits its 8 second bound, the handler future drops
  but the spawned task completes the fetch and stores the tile, so the next pan serves it from
  cache. Blank areas self-heal.
- Single-flight still coalesces: concurrent requests spawn tasks that serialize on the per-key
  lock, and the losers serve the winner's stored tile from the re-check. The existing
  `fetches_caches_and_coalesces_duplicate_misses` test must stay green. The
  `inflight_finish` strong-count heuristic stays correct: only spawned tasks hold lock clones.
- Egress load stays bounded by the existing `EGRESS_CONCURRENCY` semaphore (8) and by
  single-flight per tile; a detached task holds a permit at most one timeout per attempt (the
  permit is re-acquired per attempt), worst case 40s then 80s at the default base.
- Shutdown: a container stop cancels detached fills and may lose in-flight scroll-tile writes.
  Same exposure as today (a cancelled handler loses the same write); scroll tiles are
  disposable cache, region pins flush through the warm engine. Documented, not mitigated.

### 5. Stats surface (`routes.rs`)

`GET /cache/stats` gains a new top-level sibling key `upstream`, built in the handler with
`serde_json::json!` from `health.snapshot()`, present only for sources with a live health
entry (camelCase wire keys, `lastTimeoutAt` in Unix epoch seconds):

```json
"upstream": { "depth-noaa-enc": { "slow": true, "timeoutSecs": 80, "lastTimeoutAt": 1751690000 } }
```

The plugin's `/api/cache/stats` spread (`regions-routes.ts:206`) passes it through with no
plugin change. Panel badge UI is out of scope for this issue (the issue marks it optional); it
can ride a later panel change with the UI team process.

### 6. Explicitly out of scope

- The rootless podman port-forward wedge from the issue notes (host-side healthcheck through the
  published port): separate concern, gets its own follow-up issue.
- Panel "degraded" badge UI.
- Geocode and style-document-learn timeouts stay at the client default.
- Runtime tuning of the timeout base (no POST /config field, no env var).

## Tests (TDD, `cargo test --workspace`)

`health.rs` unit tests (clock injected, no timers, no network):
1. Schedule escalates base, base*2, base*4 and caps at 90_000 and streak 2.
2. Success within the quiet window keeps the escalated timeout (sticky).
3. Success after 300 quiet seconds resets the entry, and `is_slow` flips false.

`fetcher.rs` integration tests. Flake control on a loaded Raspberry Pi: stubs key their
behavior on a hit counter (slow on early hits, instant after), so assertions never sit on a
thin sleep-versus-timeout margin; every forced timeout has at least 10x headroom (100ms
timeout against a 1 second stub sleep), and every required success answers instantly.

4. Retry-once: base 100ms; stub hit 1 sleeps 1s, hit 2 answers instantly. Assert `Hit` and
   exactly 2 upstream hits.
5. A timeout is never negative-cached: stub sleeps 1s on every hit; base 100ms. Assert
   `Unavailable` and no cache row for the key (contrast: existing `negative_caches_a_404`).
6. Adaptive escalation end-to-end: base 100ms; stub hits 1 and 2 sleep 1s (request 1 times out
   at 100ms and 200ms, streak reaches 2), later hits answer instantly. Second `get_tile`
   succeeds and `timeout_ms` for the source reads 400ms at that moment (asserted via the
   health API, not timing).
7. Detached fill survives caller cancellation: default base (no adaptive timing in play); stub
   sleeps 200ms then serves; wrap `get_tile` in `tokio::time::timeout(50ms, ...)` and drop it;
   poll the cache (bounded, up to ~5s) until the row appears.
8. Slow source serves stale immediately: prime the cache, `fresh_secs: 0`, record a timeout so
   the source is slow, stub sleeps 1s; `get_tile` returns a stale `Hit` well before the stub
   would answer (bound the await at 500ms).
9. Stats: after a recorded timeout, the stats handler JSON carries `upstream.<id>.slow == true`
   and `timeoutSecs` matching the escalated value.

Plugin: no code change, no new tests (`test/cache-routes.test.ts` already proves the stats
body spread passes unknown fields through).

## Version, docs, release

- Any `container/` change requires a plugin version bump (image tag pinned to version):
  0.2.0 to 0.3.0 (new feature and a new stats field).
- CHANGELOG dated entry; README "What's New" overwritten to 0.3.0.
- CLAUDE.md "Layout and status" tilecache paragraph gains one sentence, draft: "The egress
  fetch path adapts to slow upstreams: a per-source timeout backs off 20s, 40s, 80s while a
  source keeps timing out (sticky until 5 quiet minutes), a timed-out fetch retries once, a
  timeout is never negative-cached, tile fills run detached so a browser or proxy disconnect
  no longer cancels a slow fetch, and per-source health surfaces as `upstream` on
  /cache/stats."
- No `prepare` or `prepack` lifecycle script is added to `package.json` (none exists today;
  the release gate re-checks).
- `.github/workflows/container-image.yml` exists and listens on the `v*` tag push (verified);
  the release git tag must be exactly `v` + the `package.json` version.
- Release per `docs/superpowers/2026-06-30-publish-runbook.md` and the pre-push checklist:
  gates (npm test/typecheck/lint/build, cargo test/clippy/release build), `/simplify`,
  `rust-signalk-expert` review, deps current, compliance items, tag `v0.3.0`, verify publish
  and image, then close issue #3 and file the follow-up healthcheck issue.
