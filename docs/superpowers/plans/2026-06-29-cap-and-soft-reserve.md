# Cap slider and soft-reserve Implementation Plan

> **For agentic workers:** execute with the superpowers:subagent-driven-development workflow. Two
> tasks, each a TDD unit: write the failing test, run it and watch it fail, write the minimal
> implementation, run it and watch it pass, then commit. Fix every finding of every severity.

**Goal:** Size the tile cache for a real microSD (default cap to about 80 percent of detected free
space, shown as a GiB slider), and change the saved-regions reservation from a hard pre-reserve to a
soft reserve so the on-demand scroll cache uses the whole cap until a region is actually saved.

**Architecture:** Two independent changes, two commits. Task 1 is plugin TypeScript only: a
GiB-valued cap knob with a free-space-derived default and a slider widget, plus aligning the
regions-budget knob to GiB. Task 2 is the Rust container: R becomes a ceiling on pinned bytes rather
than a pre-reservation, a region warm evicts only unpinned scroll tiles to fit and never pinned, and
`evict_to` is bounded at `cap` rather than `cap - R`.

**Tech stack:** Plugin TypeScript with `@signalk/server-api` (tests via node --test through tsx).
Container Rust (cargo workspace, rusqlite bundled, axum), tests via `cargo test --workspace`.

## Global Constraints

- Trust boundary: the plugin holds the admin gate, the budget gate, and all Signal K reads; the
  container is tokenless and Signal K agnostic. This change adds `fs.statfsSync` in the plugin only,
  and pure in-process eviction logic in the container. No new egress, no native library, no Signal K
  read in the container.
- SI units internally (bytes). The GiB cap field is a display-edge representation: convert
  `capBytes = capGiB * 1024 ** 3` (binary GiB) once, at the plugin edge. Everything downstream stays
  bytes.
- Two-budget invariant after Task 2: `pinned_bytes <= R <= cap` and `total_bytes <= cap`. R is a
  ceiling on total pinned bytes, not a pre-reservation. A region warm never evicts a pinned tile; it
  evicts only unpinned scroll tiles to fit, and marks `capped` only when the pinned set cannot fit
  under the effective budget. `pinned_bytes == SUM(bytes WHERE pinned=1)` and
  `total_bytes == SUM(bytes)` stay exact on every mutating path.
- Writing style: no em dashes (colon, comma, or two sentences), Oxford commas, write "and" never the
  ampersand in displayed or written text, "chartplotter" one word, no AI-process talk in commits,
  comments, docs, or UI text.
- Build and test: plugin `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Container
  `cd container && cargo test --workspace`, then `cargo clippy --workspace --all-targets -- -D
  warnings`, then `cargo build --release --bin tilecache`. The first Pi cargo build is slow: allow a
  long timeout and re-run if a window is not enough (cargo resumes). No `prepare`/`prepack` lifecycle
  script in `package.json`.

---

### Task 1: GiB cap slider with a free-space default, and GiB regions-budget alignment

**Files:**
- Modify `src/plugin/plugin.ts`: replace the bytes cap knob with a GiB cap knob, add the slider via
  `uiSchema`, compute the free-space default in `schema()`, convert GiB to bytes once in `doStart`,
  and keep the `R <= cap` clamp. Align the regions-budget knob to GiB.
- Modify `src/runtime/tilecache-container.ts`: reconcile the cap default constant to a single GiB
  source.
- Modify `README.md`: rewrite the cache-size sentence for the GiB slider (the soft-reserve sentence
  is rewritten in Task 2).
- Modify the plugin tests that reference the cap or regions-budget config keys (search `test/` for
  `tilecacheCacheCapBytes` and `tilecacheRegionsBudgetBytes`).

**Exact changes:**
- Define ONE fallback constant, `const DEFAULT_CACHE_CAP_GIB = 8`, and derive bytes from it
  (`DEFAULT_CACHE_CAP_GIB * 1024 ** 3`) wherever a cap default is needed. Remove the old
  `DEFAULT_CACHE_CAP_BYTES` const at `plugin.ts:31-32` and its now-wrong "mirrors the schema default"
  comment, and the duplicate in `tilecache-container.ts:19`: keep a single source (export the GiB
  constant or the derived bytes from one module and import it in the other).
- `CompanionConfig` (`plugin.ts:25`): replace `tilecacheCacheCapBytes?: number` with
  `tilecacheCacheCapGiB?: number`, and `tilecacheRegionsBudgetBytes?: number` with
  `tilecacheRegionsBudgetGiB?: number`.
- `schema()` cap field (`plugin.ts:205` area): a `tilecacheCacheCapGiB` property,
  `type: 'integer'`, `multipleOf: 1`, `minimum: 1`, a FIXED `maximum: 1024` (do NOT set a dynamic
  `maximum` from free space: rjsf ajv8 enforces `maximum`, so a stored cap above a shrunken or
  external-drive value becomes an unsaveable validation error on an untouched field, and it would cap
  the value at the SD's free space even when the cache is on a larger external drive). Compute only
  the `default` from free space:
  ```ts
  // schema() is the function form; the Signal K server re-invokes it each time the admin UI fetches
  // config, after it binds getDataDirPath onto the app copy. Guard the early-call case (an unbound
  // getDataDirPath throws) and any statfs failure, falling back to the static default.
  let capDefaultGiB = DEFAULT_CACHE_CAP_GIB
  try {
    const dataDir = (app as unknown as { getDataDirPath: () => string }).getDataDirPath()
    const { bsize, bavail } = statfsSync(dataDir)
    const freeGiB = Math.floor((bsize * bavail) / (1024 ** 3))
    capDefaultGiB = Math.max(1, Math.floor(freeGiB * 0.8))
  } catch {
    // Detection failed (early call or a platform without statfs): keep the conservative default.
  }
  ```
  Put the whole `getDataDirPath()` call inside the `try`, not just `statfsSync`. Import
  `statfsSync` from `node:fs`.
  - Title: `Tile cache size cap (GiB)`.
  - Description (no em dashes, no ampersands, Oxford commas): "The most disk space the on-disk tile
    cache may use. When the cache reaches this size it evicts the least recently used unpinned tiles
    to stay under the cap. The default is about 80 percent of the free space detected on the Signal K
    data directory when this form loaded, which leaves roughly 20 percent headroom. Do not set this
    to all of your free space: the cache grows to fill the cap, and a full disk can stop the server
    from writing. If you point the cache at an external drive in the field below, this value reflects
    the data directory filesystem, not the drive, so set the cap manually to suit the drive."
- `schema()` regions-budget field: rename to `tilecacheRegionsBudgetGiB`, `type: 'integer'`,
  `minimum: 0`, `default: 0`, title `Saved-regions reserved budget (GiB)`, description that 0 reserves
  half the cap and that this is a ceiling on how much saved regions may pin, not space taken from the
  scroll cache until a region is saved. House-style widget `updown`.
- Add a plugin `uiSchema` (a property on the returned plugin object, alongside `schema`):
  ```ts
  uiSchema: {
    tilecacheCacheCapGiB: { 'ui:widget': 'range' },
    tilecacheRegionsBudgetGiB: { 'ui:widget': 'updown' }
  }
  ```
  (`@signalk/server-api`'s `Plugin.uiSchema` is honored by the admin UI; the rjsf `range` widget
  renders a slider with a numeric readout and reads its step from `multipleOf`.)
- `doStart`: compute `const capBytes = (config.tilecacheCacheCapGiB ?? DEFAULT_CACHE_CAP_GIB) * 1024
  ** 3` ONCE, and feed BOTH cap consumers: the `buildTilecacheConfig` knob (`plugin.ts:108`,
  replacing the `typeof config?.tilecacheCacheCapBytes === 'number'` guard) and the R base
  (`plugin.ts:122`). Compute `const rawR = (config.tilecacheRegionsBudgetGiB ?? 0) > 0 ?
  config.tilecacheRegionsBudgetGiB! * 1024 ** 3 : Math.floor(capBytes * 0.5)` and KEEP the clamp
  `const regionsBudgetBytes = Math.min(rawR, capBytes)` (this is the sole plugin-side guarantee of
  `R <= cap`). `positionWarmBudgetBytes(regionsBudgetBytes)` unchanged.
- README.md cache-size sentence (around line 83): rewrite "Set the maximum cache size (in megabytes)"
  to describe the GiB slider and the free-space default. (The "prewarmed box is pinned within this
  budget" sentence is rewritten in Task 2.)

**Tests:** Update any test that constructs config with `tilecacheCacheCapBytes` or
`tilecacheRegionsBudgetBytes` to the GiB keys. If `schema()` is unit-testable, assert the cap field is
`type: 'integer'`, has a fixed `maximum: 1024`, a `minimum: 1`, and a default `>= 1`; assert the
plugin exposes `uiSchema` with a `range` widget on the cap. A pure free-space-default unit test is not
required if there is no seam; state that in the report.

Steps: write or update the failing tests, run and watch fail, implement, run and watch pass, then
`npm run typecheck`, `npm run lint`, `npm run build`, all green. Commit: `feat(plugin): size the tile
cache cap to free space with a GiB slider, align the regions budget to GiB`.

---

### Task 2: Soft reserve in the container

**Files:**
- Modify `container/tilecache/src/cache.rs`: change the make-room logic in `put_many_pinned`, remove
  make-room from `pin_if_fresh` and `pin_for_region`, add an inner unlocked evict helper, and update
  the stale doc comment.
- Modify `container/tilecache/src/warm.rs`: `effective_budget` clamps to the cap.
- Modify `container/tilecache/src/fetcher.rs` and `style.rs`: flip `evict_to(cap - R)` to
  `evict_to(cap)`, and update the comments.
- Modify `container/tilecache/src/routes.rs`: flip the delete-route `evict_to`, and update the stale
  comments and docstrings.
- Modify `container/tilecache/src/state.rs`: update the `live_cap_bytes` and `live_regions_budget`
  comments.
- Modify `docs/superpowers/specs/2026-06-29-saved-regions-design.md` and the saved-regions plan's
  two-budget note: describe the soft reserve.
- Modify `README.md`: rewrite the "prewarmed box is pinned within this budget, position-warm fills the
  remainder under LRU" sentence for the soft-reserve model.

**Exact changes (fold every correctness finding):**
- `effective_budget` in `warm.rs`: clamp to the cap so `R <= cap` holds in the container regardless of
  what POST /config delivered. Read `live_cap_bytes` too:
  ```rust
  fn effective_budget(st: &AppState, region_id: Option<&str>) -> i64 {
      let cap = st.live_cap_bytes.load(Ordering::Relaxed);
      let r = st.live_regions_budget.load(Ordering::Relaxed);
      let p = st.live_position_warm_budget.load(Ordering::Relaxed);
      let raw = if region_id == Some(crate::state::POSITION_WARM_REGION_ID) { r } else { r - p };
      raw.min(cap).max(0)
  }
  ```
- An inner unlocked evict helper in `cache.rs` that runs the existing LRU-delete-of-unpinned logic on
  a caller-supplied open transaction, returns the freed bytes, and opens NO transaction of its own
  (the caller already holds one; a nested `unchecked_transaction` errors "cannot start a transaction
  within a transaction"). Refactor `evict_to` to lock, open its own tx, call this helper, and update
  the counter, so the logic lives in one place:
  ```rust
  // Deletes least-recently-used UNPINNED rows on the caller's open transaction until the total of
  // all rows is at or below target. Returns the bytes freed. Never deletes pinned rows. Does not
  // touch pinned_bytes (it only removes pinned=0 rows). The caller updates total_bytes by the
  // returned amount.
  fn evict_unpinned_within(tx: &rusqlite::Transaction, current_total: i64, target: i64)
      -> rusqlite::Result<i64>
  ```
  (Match the exact ordering, the LRU column, and the per-row byte read that the current `evict_to` at
  `cache.rs:193-213` uses.)
- `put_many_pinned`: INSERT then evict, never the reverse.
  1. Gate first: as today, sum the per-row pin contributions (full bytes when a row newly enters the
     pinned set, the net delta when it was already pinned), and if `pinned_base + pinned_added +
     pin_delta > effective budget` set `capped` and break. The caller passes the effective budget
     (already cap-clamped by `effective_budget`).
  2. INSERT OR REPLACE all the batch rows with `pinned = 1` inside the open transaction, and insert
     their `region_tiles` join rows. This flips any pre-existing unpinned scroll row to pinned, so it
     is eviction-exempt before any eviction runs (this is why insert must precede evict: evicting
     first could delete the very row about to be re-pinned, turning a replace into a fresh insert and
     under-counting `total_bytes` by the old bytes).
  3. Make room: compute the new running total `base + added`, and if it exceeds the cap call
     `evict_unpinned_within(&tx, base + added, cap)` ONCE to drop unpinned LRU down to the cap, where
     `cap = st`-supplied (thread the live cap into `put_many_pinned`, or read it from a field). Read
     `let cap = ...` from a new `cap: i64` parameter on `put_many_pinned` (the warm caller passes
     `st.live_cap_bytes.load(...)`). Capture `freed`.
  4. Commit. Update both counters exactly: `inner.total_bytes = base + added - freed;`
     `inner.pinned_bytes = pinned_base + pinned_added;`. Because the gate already bounds pinned `<=`
     the cap-clamped budget `<= cap`, the pinned set always fits after evicting unpinned, so the
     "mark capped after eviction" branch is unreachable; keep the gate as the only capped path.
  5. The `put_many_pinned` doc comment at `cache.rs:215-216` ("A warm NEVER evicts") becomes "A warm
     never evicts a PINNED tile; it evicts unpinned scroll tiles to fit within the cap."
- `pin_if_fresh` and `pin_for_region`: NO make-room and NO eviction. They pin an existing cached row
  by key with `UPDATE tiles SET pinned = 1`, adding no bytes, so `total_bytes` is unchanged and is
  already `<= cap`. Keep ONLY the existing R gate (when the row is newly pinned and has positive
  bytes, refuse if `pinned_bytes + tile_bytes > budget`) and the existing exact accounting. Adding
  eviction here would be wrong: it could evict the same unpinned LRU row the call is about to pin, so
  the `UPDATE` matches zero rows (a silent pin failure) while `pinned_bytes` still grows, drifting the
  counter. (`pin_for_region` has no live caller outside tests; leave it correct and gated, do not add
  eviction.)
- `evict_to` call-site flips, `cap - R` to `cap`: `fetcher.rs:127` (store_200), `style.rs:188`
  (vector_tile), and `routes.rs:138` (the delete route). `evict_to(cap)` evicts only unpinned rows
  until total `<= cap`, so the scroll cache uses the whole cap minus the actually-pinned bytes (the
  full cap when nothing is pinned). Note in a one-line comment that the `evict_to` in
  `delete_region_route` is now effectively a no-op (`delete_region` demotes pinned tiles to unpinned
  without changing `total_bytes`, so total is already `<= cap`); keep the call for safety.
- `regionsFreeBytes` (`routes.rs:66`): unchanged, `((r - p) - real_pinned).max(0)`. Do NOT assert
  `pw <= P` as an invariant: the position-warm pseudo-region is gated at R, not P, so `pw` can
  structurally exceed P (it stays small only because of the position-warm sizing). When `pw > P`,
  `regionsFreeBytes` can over-grant, but soft reserve degrades gracefully: the container's cap-clamped
  `R - P` gate, plus make-room, plus never-evict-pinned, still hold `total <= cap`, so an over-granted
  real-region warm simply caps. State this as the robustness argument, do not lean on `pw <= P`.
- Stale comments and docs to update so the diff is self-consistent: `fetcher.rs:126`, `style.rs:187`,
  `routes.rs:88-92` (the `config` docstring "physical total can sit above cap - R"), `routes.rs:131-138`
  (the `delete_region_route` doc "trim the scroll cache back to S = cap - R"), `state.rs:100-104`
  (`live_cap_bytes` "bounded at cap - R", `live_regions_budget` "hard-reserved"), and `cache.rs:215-216`.
  Update the spec's two-budget invariant and the saved-regions plan note to the soft reserve. Rewrite
  the README "prewarmed box is pinned within this budget, position-warm fills the remainder under LRU"
  sentence to: saved regions are pinned up to the reserved ceiling and are never evicted; everything
  else is on-demand scroll cache that uses the rest of the cap and is evicted least-recently-used when
  the cap is reached.

**Tests (add to the cache.rs tests module unless noted):**
- A `put_many_pinned` batch whose row PRE-EXISTS unpinned and is the LRU make-room candidate: assert
  the tile survives (it was re-pinned, not evicted), and `total_bytes` and `pinned_bytes` are exact
  (guards the insert-then-evict ordering).
- A region warm into a FULL scroll cache evicts unpinned LRU and succeeds (no longer caps), and
  `total_bytes <= cap` afterward.
- A region warm never evicts another region's PINNED tile: pin r1, fill scroll, warm r2, assert r1's
  tile survives.
- `pin_if_fresh` and `pin_for_region` do NOT evict and leave `total_bytes` unchanged.
- Scroll fills the FULL cap when nothing is pinned (the headline behavior change). The existing
  `scroll_eviction_is_bounded_at_cap_minus_r` test calls `evict_to(400)` directly so it still passes,
  but its name documents the dead policy: rename or repurpose it to the full-cap-scroll policy.
- The R ceiling still caps a warm that would exceed the budget even when there is disk room.
- `effective_budget` clamps a configured `R > cap` down to the cap (so a future or direct POST
  /config with R greater than the cap cannot admit pinned beyond the cap).

Steps: write the failing tests, run `cargo test --workspace` and watch them fail, implement, run and
watch pass, then `cargo clippy --workspace --all-targets -- -D warnings` and `cargo build --release
--bin tilecache`, all green. Run the plugin `npm test` to confirm no regression from the threaded cap
parameter. Commit: `feat(tilecache): soft-reserve the regions budget so the scroll cache uses the
whole cap`.

---

## Self-Review

- Cap conversion lands once at the plugin edge and feeds both `buildTilecacheConfig` and the R base;
  the `R <= cap` clamp is preserved; the GiB constant has a single source.
- The slider has no dynamic `maximum`; the free-space figure is in `default` and the description only;
  `type: 'integer'` with `multipleOf: 1` keeps the step at 1 GiB.
- `put_many_pinned` inserts before it evicts, evicts unpinned only on the caller's open transaction
  (no nested transaction), and updates both counters as `base + added - freed` and
  `pinned_base + pinned_added`. `pin_if_fresh` and `pin_for_region` do not evict.
- `effective_budget` clamps R and R - P to the cap; the invariant `pinned <= R <= cap` and
  `total <= cap` holds without leaning on `pw <= P`.
- All stale `cap - R` comments, the spec, the plan note, and the README are updated to the soft
  reserve; no doc or comment still describes the hard reserve.
