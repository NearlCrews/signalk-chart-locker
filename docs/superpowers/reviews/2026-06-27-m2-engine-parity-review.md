# Milestone 2 engine port: independent parity review

Date: 2026-06-27
Scope: read-only review of the committed Rust engine port against the TypeScript
reference, by three independent lenses (geometry and grid, A* and orchestrator,
and the harness, numerics, and safety). Status below is reconciled against the
engine state at commit `d66a825`.

## Headline

The port is faithful. Two independent algorithmic reviews found zero logic
divergences across every primitive, the A* search and its tie-break, path
simplify, the orchestrator's snap, repair, decimate, and re-check, all six
decline reasons, the result shape, and the border-fallback logic, each pinned by
oracle tests captured from the TypeScript. The findings are in the parity
harness, numeric reproducibility, decline coverage, and production-input safety,
not in the ported algorithm.

## Findings and status

### Critical

1. Bit-exact waypoint comparison versus cross-platform CI. OPEN, needs a decision.
   `container/engine/tests/parity.rs` compares waypoints with `bits_eq`
   (`to_bits() == to_bits()`) and the file comment states "exact equality is the
   right bar." The design spec section 8 says bit-exact is unattainable across
   libm implementations and prescribes a per-coordinate ulp tolerance, and the
   plan wants CI on amd64 and the Pi on arm64. The corpus was generated on this
   aarch64 host, so bit-exact passes locally but will false-fail on a different
   build host. This is a deliberate, documented choice in the engine that
   contradicts the spec, so it is a human decision: keep bit-exact and pin the
   corpus and CI to one platform, or move waypoints to a ulp tolerance (keeping
   `usedTileWater` and `borderFallback` exact) as the spec directs. Note: the
   replay provider already asserts the bbox within a ulp tolerance, so the
   pattern exists; the open question is only the final waypoint comparison.

2. NaN panic in the scanline sort. FIXED at `18eac94`. `nav_grid.rs` now sorts the
   x-intersections with `total_cmp`, which orders a non-finite coordinate
   deterministically instead of panicking.

### Important

3. FMA contraction not disabled. FIXED at `d66a825`. Added
   `container/engine/.cargo/config.toml` with `-C target-feature=-fma`; the suite
   stays green with the flag.

4. The `Deadline` and `LandLeg` decline reasons have no corpus or synthetic
   coverage. OPEN. Both appear in production code but in zero scenarios, so a port
   that silently short-circuits the full-resolution re-check would pass every
   existing case. Add a synthetic deadline test (set `deadline_ms` to a past
   epoch, assert a `Deadline` decline; `clock.rs` already centralizes the wall
   clock) and a `decline-land-leg` corpus case captured from the reference (a
   concave bay where A* finds a valid grid path but the simplified leg cuts the
   headland). The land-leg case needs a capture from the TypeScript harness, so it
   pairs with the corpus-generation tooling.

5. Panics in `geometry.rs` on malformed input. PARTIAL. The empty-anchor guard is
   in (`channel_router.rs`, `18eac94`). Still open: `position_to_bbox` panics on a
   NaN or Inf latitude or longitude, `sample_rhumb_leg` panics on a spacing of
   zero or less, and `union_bbox` panics on a non-finite edge. In the Milestone 2
   library these are reachable only from a degenerate request; the durable fix is
   to validate positions at the future HTTP boundary and to let `route_channel`
   return a decline rather than panic on a non-finite bbox. Track into the
   container-service milestone.

### Minor

6. Bare `unwrap` in the harness text scanner. FIXED at `18eac94` (now `expect`
   and `unwrap_or_else(panic!)` with case context).

7. `corpus/border-no-foreign-rings` has `borderAware: false`, so it is a baseline
   non-border test misfiled among the border scenarios. OPEN, rename or re-file so
   border coverage is not overcounted.

8. `union_bbox` is now exported; confirm it keeps the reference's non-finite
   guard. OPEN, defensive only, no routing consequence on clean provider data.

## What is well built (do not regress)

The harness loops every INDEX.json scenario with no skips. The corpus is real
high-precision captured data with genuine topology coverage (disconnected water,
island holes, border blocking, snap-past-a-pocket, and the ENC-fails-but-tile
case). `usedTileWater` and `borderFallback` are asserted separately. Decline-reason
equality is asserted through the typed enum's kebab-case serialization, which is
the primary parity signal. The FileProvider keys on band, not on the bbox, which
absorbs sub-ulp bbox differences while still asserting the bbox within tolerance.

## Open items summary

- Decision: waypoint bit-exact versus ulp tolerance (finding 1).
- Work: deadline and land-leg coverage (finding 4), the remaining geometry
  malformed-input guards (finding 5), and the corpus naming fix (finding 7).
