# Plan: improvements 1 to 6 plus the two small items

Scope: implement the eight improvements agreed with the user. TypeScript plugin under `src/`, Rust
tilecache container under `container/tilecache/src/`. No behavior change to stored config or the data
model. Every batch must leave the gate green (Rust: `cargo test --workspace`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo build --release`; TS: typecheck, lint, test, build).

Execution order is risk-ascending, gating after each batch so a regression is easy to bisect.

## Batch A (low risk, TypeScript and small Rust)

### Item 3: share the panel fetch scaffolding
- Extract a hook `useAbortableFetch` in `src/panel/hooks/` that owns the fetch, the
  `AbortSignal.any([unmountController, AbortSignal.timeout(PANEL_REQUEST_TIMEOUT_MS)])`, and the
  canceled or unmount cleanup, and exposes a `run(handler)` the caller invokes once (use-cache-info) or
  on an interval (use-status).
- `use-status.ts` keeps its poll interval, visibility pause, in-flight guard, and byte-identical-skip;
  it delegates only the fetch-and-abort mechanics.
- `use-cache-info.ts` becomes a single `run` on mount.
- Risk: low. Covered by the existing panel-logic and hook behavior; no data-model change.

### Small-a: SSRF local-use NAT64 prefix
- In `ssrf.rs`, reject the whole RFC 8215 local-use NAT64 prefix `64:ff9b:1::/48` outright (any address
  in it is a translation address), by matching `s[0]==0x0064 && s[1]==0xff9b && s[2]==0x0001` and
  returning forbidden. Add a test.
- Risk: low. Pure defense in depth, no behavior change for real upstreams.

## Batch B (medium risk, Rust refactors)

### Item 2: deduplicate the style.rs single-flight handlers
- Extract one async helper capturing the shared shape: cache-first serve, single-flight lock plus
  re-check, fetch, store, and negative handling. Parameterize by the cache key `(source, z, x, y)`, the
  upstream URL plus its `host_allowed` check, the 200 response builder (raw content-type plus body for
  glyphs and sprite, `tile_response` for vector), and the negative policy (glyphs and sprite return 404
  without caching; vector negative-caches). `glyphs`, `sprite_variant`, and `vector_tile` call it.
- Keep the exact serve semantics each has today; this is a structure change only.
- Risk: medium. Concurrency-sensitive. Verify the warm and style tests stay green.

### Item 6: record the learn outcome in StyleState
- Add a per-source outcome to `StyleState` (a `HashMap<String, SourceLearn>` where `SourceLearn` is one
  of `Usable`, `HostRejected`, `Unresolvable`), set in `fetch_and_learn` as each source is classified.
- `style_doc`'s fail-closed strip consumes the recorded outcome instead of re-deriving `host_allowed`
  from the raw JSON: strip any source recorded `HostRejected` (or any source with a `url` or `tiles`
  not recorded `Usable`).
- Also check `host_allowed` on an inline `tiles` array in `fetch_and_learn`, closing the gap where an
  inline off-allowlist tiles source was learned as usable.
- Risk: medium. Trust-boundary code. Preserve the current fail-closed guarantee exactly; the outcome map
  is an internal decision record, not a wire change.

### Small-b: TileKey struct
- Introduce `struct TileKey<'a> { source: &'a str, z: u32, x: u32, y: u32 }` (Copy) in `cache.rs`.
- Change `get`, `put`, `touch`, `pin_if_fresh`, `pin_for_region`, `pin`, and `region_bytes`-style
  per-tile methods to take `TileKey`, dropping the two `#[allow(clippy::too_many_arguments)]`.
- Update every call site in `fetcher.rs`, `style.rs`, `warm.rs`, `routes.rs`, and the cache tests.
- Risk: medium churn, mechanical. Purely a signature refactor, zero behavior change.

## Batch C (higher risk, accounting and concurrency)

### Item 4: memoize the real-region pinned-bytes scan
- Do NOT hand-maintain an incremental counter (drift risk against the exact scan). Instead cache the
  last `real_region_pinned_bytes` result on `Inner` with a dirty flag; invalidate the flag on any pin,
  unpin, or `delete_region`. `real_region_pinned_bytes` recomputes the scan only when dirty, else
  returns the cached value. Correctness stays identical to the scan; the win is that `/cache/stats`
  polled with no region change skips the per-tile scan.
- Risk: medium. The invalidation must cover every path that changes region membership (pin_if_fresh,
  pin_for_region, pin, put_many_pinned, delete_region). Miss one and the value goes stale.

### Item 5: eliminate the per-delta statSync on the regions loader
- Change `createCachedRegionsLoader` to return `{ getStore, stop }`. It watches the data directory with
  `fs.watch` for the `regions.json` filename and marks the cache dirty on a change event, so `getStore`
  does zero I/O between writes; on the first call, or when the watcher cannot be established, it falls
  back to the current mtime-stat behavior so it is never wrong.
- Wire `stop` into the plugin `doStop` so the watcher is torn down with the rest of the lifecycle.
- Risk: medium. Watcher lifecycle plus the file-may-not-exist case (watch the directory, not the file).

### Item 1: cache read concurrency (read-connection pool) [DEFERRED]

DEFERRED by user decision on 2026-07-04, per both plan reviews and the existing cache.rs module doc,
which already records the read pool as a deliberate deferral: microSD serializes reads, item 4 removes
the one expensive read, and get misses are network-bound. Revisit only with a measurement showing read
contention on the SSD (cacheVolumeSource) path. Original plan below, not executed.


- Keep all writes (put, put_many_pinned, touch, pin paths, evict, sweep, delete_region) and the
  in-memory `total_bytes` and `pinned_bytes` counters on the single writer `Mutex<Inner>`.
- Add a pool of read-only connections (opened `SQLITE_OPEN_READ_ONLY` on the same WAL DB) as
  `Vec<Mutex<Connection>>`, sized small (for example 4). Route the pure-SQLite reads that do NOT touch
  the in-memory counters (the `get` row-plus-blob read, the `real_region_pinned_bytes` scan, the
  `per_source_*` scans) through the pool via round-robin plus `try_lock`, falling back to the next
  connection.
- CAVEAT for the reviewers: on the primary target (a single microSD card) the disk itself largely
  serializes reads, so the mutex removal may show little real gain; the benefit is real on an external
  SSD (the `cacheVolumeSource` option). Question for review: implement now, or gate on a measurement
  showing read contention first. Default in this plan is to implement, since it is behavior-preserving
  and the SSD path benefits.
- Risk: high. WAL readers see committed snapshots (the cache is advisory, so eventual visibility is
  fine). Must ensure no read path reads the in-memory counters from a reader connection.

## Verification
- Gate after each batch. Final: full Rust gate plus full TS gate plus release build, and confirm ldd on
  the release binary still shows only libc, libm, libgcc, and the loader.
- No version bump or release in this task unless the user asks; container changes will need a bump to
  ship, noted at hand-off.
