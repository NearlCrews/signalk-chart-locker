# signalk-binnacle-companion Milestone 2: Rust engine hand-port and parity harness

**Goal:** Hand-port the crows-nest channel router (the event-loop-blocking A* and grid closure, about 1,500 LOC across `channel-router.ts`, `nav-grid.ts`, `astar.ts`, `path-simplify.ts`, `tile-water-query.ts`, and the `leg-geometry.ts` primitives) into a Rust `engine` crate in the companion, and prove parity against the TypeScript reference with a replay corpus. Internal milestone: nothing reaches the boat until the cutover at Milestone 4.

**Why parity is achievable exactly:** the channel router's only nondeterminism is `Date.now()`, used solely for `deadlineMs` checks. With `deadlineMs` omitted or set far in the future, `routeChannel` is a pure function of its request and the provider responses. So a corpus of `(request, captured provider responses, TS result)` tuples is an exact oracle: the Rust port must reproduce the same waypoints and flags bit-for-bit.

**Source of truth:** `/home/dietpi/src/signalk-crows-nest`, builds with `tsc`, tests with `node --import tsx --test test/*.test.ts`. The channel-router tests under `test/route-draft-channel-*.ts` and `test/route-draft-leg-geometry.test.ts` are the per-module oracles.

## Architecture

- New Rust crate `container/engine/` (library plus a parity-runner binary). Pure Rust, no GDAL, GEOS, PROJ, or SpatiaLite, consistent with [[podman-runtime-healthcheck]] and the storage spike. It will later host the `LocalProvider` (Milestone 3) and be wired into the router container (Milestone 4), but this milestone keeps it provider-agnostic behind a trait.
- `Provider` trait mirrors the three calls the router makes: charted areas per band, tile water, and foreign rings. A `FileProvider` implementation replays captured JSON fixtures keyed by `(band, bbox)`, `(bbox)`, and `(bbox)`.
- The TS side gains a capture wrapper (dev and test only, never shipped) that records every provider call and result while running `routeChannel`, plus a corpus generator that emits the `(request, fixtures, result)` tuples. This is additive tooling on a crows-nest branch; the shipping router is untouched.

## The determinism checklist (the parity contract)

Every item below is a place a naive port diverges. Each must be reproduced exactly and covered by a test. Citations are into the crows-nest source.

- A. MinHeap tie-break: push sifts up while `keys[p] <= keys[i]` (`astar.ts:22`, `<=`); pop sifts down with strict `<` child tests (`astar.ts:40-41`). Equal-f order depends on insertion sequence. Port the heap byte-for-byte, do not use `BinaryHeap`.
- B. Neighbor expansion order: east, west, south, north, then the four diagonals (`astar.ts:57-60`).
- C. Diagonal anti-cornering: blocked if either orthogonal neighbor toward the diagonal is non-navigable (`astar.ts:113`).
- D. Heuristic `Math.hypot` in cell units (`astar.ts:90`); E. step cost uses `Math.SQRT2` (`astar.ts:116`). Verify `f64::hypot` and `2f64.sqrt()` match on aarch64.
- F. Scanline edge sort is stable ascending (`nav-grid.ts:368`): use Rust stable `sort_by`, never `sort_unstable`.
- G. Scanline fill boundary uses `ceil(x - 0.5)` and `floor(x - 0.5)` (`nav-grid.ts:370-373`).
- H. Finer-band-wins: within a band `blocked` is sticky, then touched cells are marked decided and skipped by coarser bands (`nav-grid.ts:159-199`).
- I. Shore erosion: single forward row-major pass reading the pre-erosion mask (`nav-grid.ts:248-268`).
- J. Standoff BFS: seed all non-navigable cells in index order, FIFO, ortho-neighbor order `[+1,0],[-1,0],[0,+1],[0,-1]` (`nav-grid.ts:290-294`).
- K. Snap ring search: expanding Chebyshev ring, `dr` outer then `dc` inner, first qualifying cell wins (`channel-router.ts:449-459`).
- L. Largest component tie-break: seeds enumerated 0..n, strict `>` so the lower seed index wins on equal size (`channel-router.ts:364-403`).
- M. RDP split: strict `>` keeps the lowest-index maximum-deviation point (`path-simplify.ts:33-34`).
- N. RDP stack order: push `[lo,far]` then `[far,hi]`, pop processes right half first (`path-simplify.ts:39-41`).
- O. `legStaysOnWater` off-water run counter resets on any on-water sample, endpoints tested explicitly (`channel-router.ts:622-633`).
- P. `usedTileWater` and deadline bail-outs return the conservative value (`channel-router.ts:703-714`).

Geometry primitives to port in degree space, matching the exact formulas: `sampleRhumbLeg`, `distanceMeters` (haversine, R = 6371000), `metersPerDegreeLon` (`111320 * cos`), `boundsOfRings`, `pointInRings` (even-odd ray cast, strict comparisons, no epsilon), `orient2D`, `segmentsCross` (proper crossing only, strict, collinear excluded), `routeBbox`, and the Web-Mercator `latToTile`/`lonToTile` (`asinh(tan(lat))`). Config constants are baked in: `DEFAULT_CELL_METERS 60`, `MAX_CELLS 250000`, `STANDOFF_WEIGHT 6`, `SIMPLIFY_EPSILON_CELLS 1.5`, `BBOX_PAD_METERS 3704`, and the rest enumerated in the contract.

## Phases

### Phase A: Parity harness (TS capture and corpus)
- A1. On a crows-nest branch, add a `CaptureProvider` dev wrapper that records each `queryChartedAreas(band,bbox)`, `queryTileWater(bbox)`, and `foreignRings(bbox)` call and its JSON result.
- A2. Build a corpus generator: drive `routeChannel` with `deadlineMs` unset over a set of requests sourced from the existing channel-router test scenarios plus a few coastal cases, and emit `corpus/<case>/{request.json, fixtures.json, result.json}`.
- A3. Commit the corpus into the companion repo under `container/engine/corpus/` (it is small JSON, version it; it is the oracle).

### Phase B: Rust port, module by module, each parity-gated by its TS unit tests
Port in dependency order, writing the Rust unit tests first from the TS test inventory (TDD), then the implementation:
- B1. Geometry primitives (`leg-geometry`, `position-utilities` subset) with `route-draft-leg-geometry` cases.
- B2. `path-simplify` (RDP) with `route-draft-channel-path-simplify` cases.
- B3. `astar` (heap, neighbor order, anti-cornering) with `route-draft-channel-astar` cases.
- B4. `nav-grid` (scanline, bands, erosion, standoff) with `route-draft-channel-nav-grid` cases.
- B5. `channel-router` orchestration (snap, components, repair, decimate, flags) with `route-draft-channel-router` cases.

### Phase C: Parity runner and bar
- C1. `FileProvider` reads the corpus fixtures.
- C2. A parity-runner binary and a `cargo test` that, for each corpus case, runs the Rust `route_channel` and asserts the waypoints and flags equal the captured TS result. Parity bar (resolved in favor of design spec section 8): waypoint longitude and latitude must match within a 2-ULP per-coordinate tolerance, while `usedTileWater`, `borderFallback`, and the decline reasons match exactly. The 2-ULP tolerance is the smallest that absorbs the cross-platform libm transcendental differences the spec describes while still catching any real regression (a divergence beyond a handful of ULP is always a logic error). This replaces the earlier bit-exact bar, which could not hold on an amd64 CI host against an aarch64-generated corpus.

### Phase D: Close the gap
Drive the parity runner to green across the whole corpus. Each divergence traces to one checklist item above. Document any residual platform float note.

## Out of scope for Milestone 2
The local geodata pipeline and `LocalProvider` (Milestone 3, gated on the ENC licensing decision), the crows-nest cutover and the in-process bridge client (Milestone 4), and any boat-facing behavior. This milestone only proves the engine reproduces the TS router on replayed inputs.
