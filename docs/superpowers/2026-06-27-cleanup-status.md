# Cleanup complete: status (2026-06-27)

A whole-repo `/cleanup` (8 lanes), the architectural deferrals, and a second 4-lane diff `/cleanup`
over the result, all in the WORKING TREE and UNCOMMITTED. Nothing is committed; the user commits.
The team agents were session-scoped; this doc plus the working tree are the record.

## Verification (all green)

- Node plugin: `npm test` 33/33, `npm run typecheck`, `npm run lint`, `npm run build` all clean.
- Rust workspace (`cd container`): `cargo test --workspace` green incl `parity_over_the_whole_corpus`
  (engine 45 unit + 2 parity + 6 deadline/non_finite, gpkg 10, localprovider 7 with testutil,
  router 4, storage-spike 5), `cargo clippy --workspace --all-targets -- -D warnings` clean,
  `cargo build --release --bin router` clean. `ldd` on the router binary shows no GDAL, GEOS, PROJ,
  SpatiaLite, or system SQLite.
- Prep: `py_compile` clean, a full real-store rebuild reproduced identical counts and a passing
  data-parity run (30/30 points, 5/8 legs held, 0 silent flips).
- Router workspace image builds clean (`podman build --format docker -t binnacle-router container`).

## What was applied (uncommitted)

- Structural (the deferrals, now done): one Cargo workspace at `container/Cargo.toml` (5 members:
  engine, gpkg, localprovider, router, storage-spike), the FMA `.cargo/config.toml` moved to the
  workspace root, a shared `binnacle-gpkg` crate that ended the duplicated WKB decoder (localprovider
  and storage-spike both use it), the engine orchestrator split into `water_index.rs` and `snap.rs`
  with `build_nav_grid` decomposed into a `GridBuild` stage struct, `EmptyProvider` and
  `UnavailableProvider` moved into the engine, the router on a single workspace build with
  `spawn_blocking`, and the Dockerfile reduced to one workspace COPY.
- In-crate: prep made data-driven (single sources for the schema and ENC ingests, unified ogr2ogr
  and ogrinfo helpers, the `keep`-column schema fix, `closing()` connections, country-field
  validation, `EncIngest` NamedTuple); localprovider statement caching, typed depth and land queries,
  shared `decode_geom`, eprintln diagnostics; engine output-identical efficiency (borrowed water
  index, bitflag-packed masks, edges reuse, deadline-syscall batching, pre-sized buffers); Node
  test-helper hoist, blank-imageTag guard, status wording, shared FetchResponse type.
- Two real harness bugs fixed in `data_parity.py` (band filter, ogrinfo returncode), and `data_parity`
  now reuses `prep_region.run`.
- Diff-cleanup corrections: reverted a `Vec<i16>` clearance back to `Vec<i32>` (the i16 bound was
  cols+rows, which an elongated grid can push past i16::MAX: a real overflow the corpus missed),
  restored the `build_buckets` `is_finite` span guards the split had dropped, plus nits.

## Deferred (with reasons), for the next pass or the user's call

- Router pre-open `LocalProvider` once (perf): by-design. Per-request open binds the per-request
  `homeCountryId` that border-aware needs; the win is small and `spawn_blocking` already moves it off
  the executor. A pre-open needs a Provider-trait change to thread home per call.
- Output-identical refactors in parity-critical code, deferred to bound risk on the verified-faithful
  splits: the `GridTransform` field dedup (would drop a `too_many_arguments` allow), the water_index
  bbox-union chain and per-set bbox-Vec inline, and the snap component label `i64`->`i32` shrink.
- `data_parity.py` subprocess-per-point to a pure-Python or SpatiaLite point-in-polygon: a validation
  tool, not a hot path; the fix risks the verified one-way safety invariant.
- `binnacle-gpkg` test-encoder dedup vs `fixture.rs`: low, the encoders are round-trip-tested.
- `docs/superpowers/` rename to `docs/design/`: cosmetic, high cross-reference churn, no functional
  gain. Recommend leaving.
- Rejected (false positive): `snap.rs` "unused `AStarGrid` import": it is used for trait-method
  resolution (`grid.cols()`, `grid.is_navigable()`); clippy confirms it is needed.

## Next

The working tree is green and ready to commit (the user commits, in logical conventional-commit
chunks). Suggested grouping: the structural workspace plus WKB dedup, the engine cleanup, the
localprovider and router cleanup, the prep rewrite, the Node cleanup, and the docs.
