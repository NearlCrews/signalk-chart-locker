# Milestone 3C: Data-parity harness Implementation Plan

> **Status: classification parity executed and PASSED against the live NOAA ENC.** The harness
> is committed at `container/prep/data_parity.py`. It was run on a real region (San Francisco
> Bay, NOAA cell US5CA13M, built by the prep tool) against the live NOAA ENC Direct service: on
> an 8x8 grid, 30 of 64 points were covered by both sources, all 30 agreed on the `inEncDeep`
> and the drying-as-land classification, with 0 load-bearing disagreements and 1 expected
> coverage-edge point. So the local GDAL S-57 prep produces depth classifications identical to
> NOAA's own ArcGIS lineage for the same charts. Remaining in 3C: the one-way leg-level safety
> invariant (Task 3) and the Node plugin lifecycle and fallback slice (Task 4), and running the
> parity over more regions. The committed harness is the implementation of Tasks 1 and 2
> (capture plus per-sample classification comparison), folded into one online-sampling script.

> **For agentic workers:** when the inputs exist, execute with
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove that the offline local data store produces routing-safety classifications that
match the online ENC source on sample regions, so the cutover to local geodata cannot make a
route read as safer than the online data supported.

**Architecture:** A comparison harness that runs the engine through `LocalProvider` (local
OSM water, local ENC, local boundaries) and compares per-sample classifications against
captured online outputs for the same areas. Shoreline geometry will differ between the
osmdata water polygons and the online water layer, and that is documented as expected, not a
failure. The load-bearing comparisons are the depth classifications that drive the honesty
signal, plus a one-way safety invariant. A separate Node-side integration test exercises the
container lifecycle and the crows-nest in-process fallback.

**Tech Stack:** Rust (the engine plus `LocalProvider` and a capture-replay reference), and
the Node plugin test harness for the lifecycle slice.

## Global Constraints

- The comparison is NOT geometry equality. Shoreline disagreement between the local osmdata
  water and the online OpenMapTiles water layer is expected and must be reported as expected,
  not failed.
- The load-bearing assertions, per spec section 8 lines 299 to 309:
  1. The `inEncDeep` classification (a sample point is in a depth area with `shallow_meters >=
     contour`) is identical between the local and the online ENC, per sample.
  2. The drying-as-land classification (`shallow_meters < 0`) is identical, per sample.
  3. The safety invariant, one-way: a leg the online path flags unsafe must NOT become
     unflagged on the local path without an explicit, logged reason.
- `DRVAL1`, `DRVAL2`, and the drying sign are load-bearing values, not metadata.
- The container computes geometry only and must never make a route read safer than the data
  supports. This milestone is the proof of that for the data swap.
- Units are SI (meters), coordinates WGS84 (EPSG:4326).

## File Structure

- `container/engine/tests/data_parity.rs` — the data-parity harness: load a real region store via `LocalProvider`, load captured online reference samples, compare classifications. Responsibility: the per-sample comparison and the safety invariant.
- `container/engine/corpus-data/` — captured online reference samples for the sample regions (sample points with the online `inEncDeep` and drying classification, and online leg-safety verdicts). Git-ignored if large, with a small committed subset for CI. Responsibility: the reference oracle.
- `test/plugin-integration.test.ts` (or an extension of the existing plugin tests) — the lifecycle and fallback slice. Responsibility: the signalk-container guard and the in-process fallback.

## Task 1: Capture the online reference samples

**Files:** Create `container/prep/capture_reference.py` (lives with prep, GDAL and network allowed) and `container/engine/corpus-data/<region>.json`.

- [ ] **Step 1.** For one sample region, query the online NOAA ArcGIS ENC Direct service and the online OpenMapTiles water layer (the same online water source the crows-nest router uses, per spec section 8) over a grid of sample points, and record per point: the online `inEncDeep` result for a fixed test contour, the online drying classification, and the `shallowMeters` the online ENC reports. Write a stable JSON (sample lon, lat, contour, in_enc_deep, drying, shallow_meters).
- [ ] **Step 2.** Commit a SMALL representative subset for CI, and document where the full capture lives (git-ignored on the NVMe). Commit. `test(parity): capture online ENC reference samples for a region`

## Task 2: The per-sample classification comparison

**Files:** Create `container/engine/tests/data_parity.rs`.

- [ ] **Step 1: Write the test.** For each captured sample, open the region store with `LocalProvider`, query `charted_areas` over a small bbox around the sample, compute the local `inEncDeep` (point in a depth area with `shallow_meters >= contour`) and the local drying classification (`shallow_meters < 0`), and assert each equals the captured online value. Report every mismatch with the sample location, the local value, the online value, and the local and online `shallowMeters`.
- [ ] **Step 2: Run it** against the staged region store and the captured samples. Mismatches are real findings: investigate whether they are S-57-versus-ArcGIS lineage differences (acceptable, documented) or a prep or reader defect (fix in 3B or 3A). Do not weaken the assertion to pass.
- [ ] **Step 3: Commit** the harness. `test(parity): assert local and online ENC classifications agree per sample`

## Task 3: The one-way safety invariant

**Files:** Extend `container/engine/tests/data_parity.rs`.

- [ ] **Step 1: Write the test.** For a set of legs over the sample region, run the leg-safety classification (the engine navigability check, which the engine already computes from `charted_areas` and `tile_water`) under `LocalProvider` and compare to the captured online leg verdicts. Assert the one-way invariant: every leg the online path flagged unsafe is also flagged unsafe locally, OR the divergence carries an explicit recorded reason. A leg that the online path flagged unsafe and the local path silently passes is a hard failure.
- [ ] **Step 2: Run it**, triage divergences, fix the data or reader cause for any unsafe-to-safe flip.
- [ ] **Step 3: Commit.** `test(parity): enforce the one-way local-versus-online safety invariant`

## Task 4: The plugin lifecycle and fallback integration slice

**Files:** Create `test/plugin-integration.test.ts` (Node). This slice does NOT need real geodata, so it can be built independently of Tasks 1 to 3, but it belongs to the M3 to M4 cutover proof.

- [ ] **Step 1: Write the test** (spec section 11 lines 360 to 362). Exercise the signalk-container runtime guard, `ensureRunning`, and `resolveContainerAddress` against a mocked container manager, and assert the crows-nest in-process fallback path is taken when the companion is down (the bridge returns `router-unavailable` and the caller falls back). This extends the existing bridge and plugin tests.
- [ ] **Step 2: Run it** with `npm test`, confirm green.
- [ ] **Step 3: Commit.** `test: cover the container lifecycle guard and the in-process fallback`

---

## Self-Review

**Spec coverage:** This plan implements the spec section 8 data-parity strategy (the
classification agreement and the one-way safety invariant) and the section 11 cell-versus
ArcGIS validation and plugin integration test. Engine parity (the FileProvider replay corpus)
is already done in Milestone 2 and is separate from this data parity, exactly as the spec's
two-test split intends.

**Honest data-gated note:** Tasks 1 to 3 need a real region store from 3B and network access
to the online ENC service to capture the reference, so they run after 3B. Task 4 (the Node
lifecycle and fallback slice) needs no geodata and could be pulled forward into the Milestone
4 cutover work if useful. The comparison methodology, the load-bearing assertions, and the
one-way safety invariant are fixed now and were checked against the spec.

## Open decisions resolved by judgement

- The reference oracle is captured online ENC samples stored as JSON, not a live online call
  in the test, so the harness is deterministic and offline-runnable once captured.
- Expected shoreline disagreement is reported, never asserted away. Only the depth
  classifications and the one-way safety invariant gate the milestone.
- A committed small sample subset keeps CI meaningful without shipping a large capture.
