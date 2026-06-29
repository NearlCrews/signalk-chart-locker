# Remove the AI route-draft feature: decommission plan

> **For agentic workers:** execute this plan repo by repo. Each repo is independent at removal time
> (no inter-repo build dependency), so order does not matter for correctness, but the suggested order is
> companion, crows-nest, then binnacle. Every task ends with the repo's full gate green.

**Goal:** Remove the AI route-draft feature end to end: the LLM call and the deterministic channel
router, geometry, safety, and geodata it used in signalk-crows-nest; the route-draft UI in
signalk-binnacle; and the now-orphaned router engine in signalk-binnacle-companion. Keep everything else,
including the companion tile cache and PMTiles chart provider, the crows-nest POI inputs and outputs, and
all manual routing in the chartplotter.

**Architecture after removal:**
- signalk-binnacle-companion: a tile cache and PMTiles chart provider only (one container, tilecache).
- signalk-crows-nest: POI inputs (ActiveCaptain, OpenSeaMap, USCG Light List, NOAA ENC Direct) and
  outputs (notes-resource, proximity-alarm, route-hazard, bridge-air-draft), the status API, and the
  position monitor. The route-draft feature is gone.
- signalk-binnacle: full manual routing (draw, edit, GPX, activate via the Course API) and every other
  panel. Only the "Draft a route with AI" and "Optimize route" controls are gone.

**Tech stack:** TypeScript (all three plugins and the webapp), Svelte 5 (webapp), Rust Cargo workspace
(companion container). Verification per repo: `npm run typecheck`, `npm test`, `npm run lint`,
`npm run build` (binnacle uses `npm run check` in place of `npm run typecheck`); for the companion also
`cd container && cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, and
`cargo build --release --bin tilecache`.

## Global constraints

- This is a deletion. The safety net is the per-repo gate staying green after every task, plus a diff
  review per repo before merge. Never mark a repo done on a red gate.
- Detach edits before deletes: in any repo, remove the imports and references to a module before deleting
  the module, or the typecheck breaks mid-task. Where a file holds both removed and kept code, edit it
  down, never delete it.
- Keep the kept features fully working. The chartplotter must still draw, edit, import, export, activate,
  and delete routes. crows-nest must still serve its POIs, notes, and alarms. The companion must still
  serve tiles, styles, PMTiles, and the prewarm panel.
- Do NOT touch the notes and POI integration in binnacle (`src/features/notes/*`, `entities/poi-icons/*`)
  or the crows-nest POI inputs and outputs. They are independent of route-draft.
- Leave dated design and decision memos under `docs/superpowers/` as historical records (project rule).
  Only the live continuation guides, the roadmaps, the READMEs, the CHANGELOGs, and CLAUDE.md get
  current-state edits.
- Each repo gets a CHANGELOG removal entry and a version bump. Do not rewrite historical CHANGELOG
  entries. Drop only the dependencies the investigators confirmed are route-draft-only.
- Style: no em dashes, use the Oxford comma, write "and" not an ampersand, "chartplotter" is one word, no
  AI-process talk in commits, CHANGELOGs, READMEs, or code comments.
- Branch per repo: `feat/remove-route-draft`. Commit in logical chunks. Merge to the repo default branch
  after the gate is green and the diff is reviewed.

---

## Repo A: signalk-binnacle-companion (retire the router engine, keep tilecache and PMTiles)

Source of the map: the companion scoping report. tilecache has zero path dependencies and shares nothing
with the deleted crates.

### Task A1: delete the routing crates, the prep tool, and fix CI

**Files (delete):**
- `container/engine/`, `container/gpkg/`, `container/localprovider/`, `container/router/`,
  `container/storage-spike/` (the whole crate dirs)
- `container/prep/` (the Python plus GDAL prep tool, not a workspace member)
- `container/Dockerfile` (the router image) and `container/prep/Dockerfile`

**Files (edit):**
- `container/Cargo.toml`, `container/tilecache/Dockerfile`, `.github/workflows/ci.yml`

**Steps:**
- [ ] Delete the five crate directories and `container/prep/`.
- [ ] Delete `container/Dockerfile`.
- [ ] Edit `container/Cargo.toml`: set `members = ["tilecache"]` (drop engine, gpkg, localprovider,
  router, storage-spike).
- [ ] Regenerate the lockfile: `cd container && cargo generate-lockfile` (or let the next build do it),
  so `container/Cargo.lock` no longer references the removed crates.
- [ ] Edit `container/tilecache/Dockerfile`: the `COPY engine gpkg localprovider router storage-spike`
  lines exist only so cargo can load every member manifest. Trim them to copy only `tilecache` plus the
  existing `Cargo.toml`, `Cargo.lock`, and `.cargo`. Confirm the build still produces `/tilecache`.
- [ ] Edit `.github/workflows/ci.yml`: repoint the rust-lint and engine-test jobs (currently hardcoded to
  `working-directory: container/engine`) to `working-directory: container`; change their cargo invocations
  to `--workspace`; and either rename the jobs to reflect tilecache scope or replace both with a single
  tilecache job that runs `cargo build --release --bin tilecache`, `cargo test --workspace`, and
  `cargo clippy --workspace --all-targets -- -D warnings`.
- [ ] Run `cd container && cargo build --release --bin tilecache` and `cargo test --workspace` and
  `cargo clippy --workspace --all-targets -- -D warnings`. Expected: green, workspace now is tilecache
  only.
- [ ] Push the branch and confirm the updated `.github/workflows/ci.yml` run is green.
- [ ] Commit: `refactor(container): drop the routing crates and the prep tool, keep the tile cache`.

**Gate:** cargo green, CI green.

### Task A2: detach the router lifecycle and the bridge from the plugin

**Files:**
- Delete: `src/bridge/route-on-water-bridge.ts` (then the empty `src/bridge/` dir),
  `src/runtime/router-container.ts`, `test/router-container.test.ts`,
  `test/route-on-water-bridge.test.ts`, `test/types.test.ts` (tests only the removed RouteOnWaterResult).
- Edit: `src/plugin/plugin.ts`, `src/shared/types.ts`, `test/helpers.ts`, `test/plugin.test.ts`,
  `test/plugin-integration.test.ts`, and the comment-only references in
  `src/runtime/container-manager.ts` and `src/runtime/tilecache-container.ts`.

**Steps:**
- [ ] In `src/plugin/plugin.ts`:
  - Fix the stale comments: rewrite line 1 (remove "launches the router container and publishes the
    in-process bridge" from the file-level description); remove or reword lines 39 and 41-42 (the note
    that "tilecache is secondary: routing is the critical path ... never blocks the router or the
    bridge"); and fix line 118.
  - Remove the router-container and route-on-water-bridge imports.
  - Remove the `imageTag` config field and the `launched` flag.
  - Remove from `doStart` the router `ensureRunning`, `resolveContainerAddress`, the throw, and
    `installRouteOnWaterBridge(createRouterBridge(...))`.
  - Make the tilecache the primary container. The tilecache launch stays non-fatal: keep the try/catch
    wrapper, because the PMTiles chart provider and the plugin serve routes work even if the tilecache
    container fails to start; only the tile cache and proxy are disabled. Do not make a tilecache failure
    throw.
  - Rewrite the status lines so they report the tilecache and charts state. The router `address` variable
    is gone; do not reference it in the rewritten status.
  - Remove from `doStop` the `removeRouteOnWaterBridge()` call and the
    `if (launched) ... stop(ROUTER_CONTAINER_NAME)` block (keep the tilecache stop block).
  - Remove the `imageTag` property from `schema()` (keep `tilecacheImageTag`, `tilecacheCacheCapBytes`,
    `tilecacheCacheVolumeSource`, and `chartsPath`).
- [ ] In `src/shared/types.ts`: remove `RouteOnWaterResult` and `RouteOnWaterBridge`. Keep `Position`,
  `FetchResponse`, and all `Container*` types.
- [ ] Delete the two source files and the three router-only test files listed above.
- [ ] In `test/helpers.ts`: drop the `removeRouteOnWaterBridge` import and its call in the cleanup helper.
- [ ] In `test/plugin.test.ts` and `test/plugin-integration.test.ts`: remove the router lifecycle, the
  bridge end-to-end assertions, the fake router container, and the `imageTag` schema assertions. Keep the
  tilecache, charts, and prewarm coverage.
- [ ] Fix the comment-only references in `container-manager.ts` and `tilecache-container.ts`.
- [ ] Run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. Expected: green.
- [ ] Commit: `refactor(plugin): remove the router container lifecycle and the route-on-water bridge`.

### Task A3: rewrite the companion docs and bump the version

**Files:** `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `package.json`, and the live continuation guide and
roadmap under `docs/superpowers/`.

**Steps:**
- [ ] `CLAUDE.md`: drop the engine, router, gpkg, localprovider, prep, and storage-spike descriptions,
  the parity bar, the deterministic-numerics and no-heavy-native-libs-for-the-engine rules framed around
  routing, the crows-nest trust boundary, the ENC distribution decision, and the border-aware boundaries
  rule. Keep the one-npm-package rule, the tile cache and PMTiles architecture, the signalk-container
  seam, and the build and test commands (tilecache only). Update "What this is" and "Layout and status"
  to the tile cache and PMTiles reality. The FMA contraction flag in `container/.cargo/config.toml` is
  now vestigial (it was parity-only for the engine); note this where it appears in CLAUDE.md but leave
  the flag itself in place, as it is harmless.
- [ ] `README.md`: rewrite the whole file. Routing pervades the current README (intro, the on-water
  routing container, engine and geodata sections, the crows-nest cross-link, the geodata setup section,
  and the build command `cargo build --release --bin router`). Every routing section goes; the build
  command becomes `cargo build --release --bin tilecache`. The rewritten README describes the tile cache
  and PMTiles chart provider only.
- [ ] `CHANGELOG.md`: add a dated entry recording the router-engine removal and the tile-cache-only
  scope.
- [ ] `package.json`: bump the version and update `signalk.recommends`: drop `signalk-crows-nest` (the
  routing bridge that linked them is gone) and keep `signalk-binnacle` (it consumes the PMTiles and
  cached tiles).
- [ ] Note in the continuation guide and roadmap that the router and the M1 through M4 work are removed;
  leave the dated milestone, spec, and decision memos as historical records.
- [ ] Run the full gate again (npm and cargo) to confirm nothing regressed. Commit:
  `docs: rewrite the companion docs for the tile-cache-and-PMTiles-only scope`.

---

## Repo B: signalk-crows-nest (cut the route-draft feature, keep the POI plugin)

Source of the map: the crows-nest scoping report. route-draft is wired only in `src/plugin/plugin.ts`
(not in `src/index.ts`). The shared POI inputs (openseamap, noaa-enc, http clients, dedupe-pois) STAY;
only `src/inputs/vector-tiles/` is route-draft-only.

### Task B1: detach the route-draft wiring from the plugin and the panel

Do the detach edits BEFORE the deletes so typecheck never breaks mid-task.

**Files:** `src/plugin/plugin.ts`, `src/panel/PluginConfigurationPanel.tsx`, `src/panel/config-reducer.ts`,
`src/panel/normalize-config.ts`, `src/shared/types.ts`.

**Steps:**
- [ ] `src/plugin/plugin.ts`: remove the route-draft imports (including the input clients used here only
  for route-draft: `createEncDirectClient`, `createOverpassClient`, `createVectorTileClient`,
  `DEFAULT_TILE_STYLE_URL`, `resolvePrimaryEndpoint`, and the `OverpassClient` and `VectorTileClient`
  types); the route-draft state vars; the route-draft block in `teardown()`; `startRouteDraft()` and its
  call; collapse `registerWithRouter` to the status registrar only; remove `routeDraftConfigSchema()` and
  the `/api/route-draft` OpenAPI block and its description. The modules `enc-direct-client`,
  `overpass-client`, and `overpass-endpoints` STAY (the POI inputs use them); only their imports leave
  this file.
- [ ] `src/panel/PluginConfigurationPanel.tsx`: drop the RouteDraftingSection import and its usage.
- [ ] `src/panel/config-reducer.ts`: drop the RouteDraftPropulsion import, the route-draft action types,
  and their cases.
- [ ] `src/panel/normalize-config.ts`: drop `normalizeRouteDraftConfig` and its `Object.assign`. KEEP the
  route-corridor import and call (that is route-hazard, not route-draft).
- [ ] `src/shared/types.ts`: drop the routeDraft* fields and the now-unreferenced `Propulsion` type.
- [ ] Run `npm run typecheck`. Expected: green (no orphaned references), even though the route-draft dir
  still exists.
- [ ] Commit: `refactor(plugin): detach the route-draft wiring`.

### Task B2: delete the route-draft source, assets, scripts, and tests

**Files (delete):**
- `src/route-draft/` (entire dir), `src/inputs/vector-tiles/`, `src/shared/regions.ts`,
  `src/shared/with-deadline.ts`, `src/panel/components/RouteDraftingSection.tsx`, `assets/boundaries/`,
  `scripts/build-boundaries.mjs`
- Tests: all `test/route-draft-*.test.ts`, `test/vector-tile-client.test.ts`,
  `test/shared-regions.test.ts`, `test/rhumb-interpolation.test.ts` (every test in this file covers
  `rhumbDistanceMeters` or `sampleRhumbLeg`, which are removed; delete the whole file)
- Docs: `docs/route-draft-api.md`

**Steps:**
- [ ] Before deleting `src/shared/regions.ts` and `src/shared/with-deadline.ts`, re-grep to confirm no
  non-route-draft, non-test importer remains.
- [ ] Delete all the files and directories listed above.
- [ ] `src/geo/position-utilities.ts`: remove `rhumbDistanceMeters` and `sampleRhumbLeg` (sole callers
  were route-draft); KEEP `distanceMeters` and the rest.
- [ ] Re-word the stale route-draft comments in these retained files (do not delete the files; update the
  comments only):
  - `src/shared/bbox-tiles.ts` line 3
  - `src/shared/length.ts` lines 7 and 24
  - `src/shared/strings.ts` line 27
  - `src/inputs/noaa-enc/depth-area-query.ts` line 4
  - `src/inputs/noaa-enc/enc-direct-types.ts` line 21
  - `src/inputs/http-client.ts` lines 264 and 310
  - `src/inputs/openseamap/coastline-query.ts` line 2
  - `src/inputs/openseamap/element-summary.ts` line 4
  - `src/status/admin-gate.ts` line 12
  - `test/overpass-client.test.ts` line 308
- [ ] `test/config-reducer.test.ts` and `test/plugin.test.ts`: remove the route-draft assertions.
- [ ] Run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. Expected: green.
- [ ] Commit: `refactor: remove the route-draft feature source, assets, and tests`.

### Task B3: drop the route-draft dependencies and update the docs

**Files:** `package.json`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/development.md`.

**Steps:**
- [ ] `package.json`: drop `@mapbox/vector-tile` and `pbf` (only `vector-tile-client.ts` used them);
  remove the `build:boundaries` script. Keep `handlebars` and `lru-cache`. Refresh the lockfile with
  `npm install`. Bump the version and refresh `signalk.recommends`.
- [ ] `README.md`: remove the route-draft sections: What's New, the beta warning, the feature bullet, the
  config, the API-guide link, the `design.draft` (`value.maximum`) Signal K path bullet, and both EMODnet
  references (the feature reference near line 104 and the data attribution near lines 342-343). Overwrite
  "What's New" to the removal release.
- [ ] `CHANGELOG.md`: add a dated removal entry. Leave the historical entries intact.
- [ ] `CLAUDE.md`: rewrite to the POI-plugin-only architecture. Keep the POI inputs, outputs, shared
  infra, and status API sections. Remove every route-draft subsystem: the AI route-draft endpoint, channel
  router, vector-tiles water source, EMODnet, openrouter, budget, regions, rhumb helpers, and
  design.draft.
- [ ] `docs/development.md`: update the architecture tree to remove the route-draft/, vector-tiles/, and
  channel-router/ directories; update the feature paragraph (around lines 58-70) to reflect the
  POI-only scope; remove the RouteDraftingSection reference (around line 170); and remove the link to the
  deleted `docs/route-draft-api.md` (around line 70).
- [ ] Run the full gate again. Commit: `docs: drop the route-draft deps and update the docs`.

### Task B4: delete the mooted M4 cutover branch

**Steps:**
- [ ] After Repo B is merged, delete the stale unmerged branch in crows-nest if it exists locally:
  `git branch -D feat/m4-companion-cutover 2>/dev/null || true`. It was the route-draft-via-companion
  cutover, now removed. The branch may only exist on another clone; skip if absent.

---

## Repo C: signalk-binnacle (remove the AI draft UI, keep all manual routing)

Source of the map: the binnacle scoping report. Manual routing, GPX, and activation are independent of
the draft. The entanglement is `RouteDraftPanel.svelte` (it also holds the manual Save and Cancel edit
shell) and the App.svelte draft seam.

### Task C1: reinline the manual edit shell, detach the draft UI, and remove the App.svelte seam

App.svelte passes nine draft props to RoutesPanel and passes `{onRouteEdited}` to ChartCanvas; removing
RouteDraftPanel's bindings without fixing App.svelte in the same pass leaves `npm run check` red. Do all
the detach and App edits together before running the gate.

**Files (edit):** `src/features/routing/RoutesPanel.svelte`, `src/features/routing/index.ts`,
`src/features/route-edit/route-edit.ts`, `src/widgets/chart-canvas/ChartCanvas.svelte`,
`src/app/App.svelte`

**Files (delete):** `src/features/routing/RouteDraftPanel.svelte`,
`src/features/routing/route-draft-client.ts`, `src/features/routing/route-draft-parse.ts`,
`src/features/routing/draft-format.ts`, `test/route-draft-client.test.ts`, `test/draft-format.test.ts`

**Steps:**
- [ ] In `RoutesPanel.svelte`: replace the `<RouteDraftPanel>` wrapper with the residual non-draft manual
  edit group. Carry over from `RouteDraftPanel.svelte` explicitly:
  - the `Save` and `X` icon imports from `@lucide/svelte`
  - the `promptSaveName` import from `$shared/ui` and the local `promptSave` helper function
  - the `.editing` CSS (the border, tint, and box-shadow for a route under edit)
  - the Save and Cancel strip, the RouteEditPlan, and the "Tap the chart to add waypoints" hint that
    lived inside RouteDraftPanel's `{#if working}` block
  Drop the `RouteDraftPanel` and `DraftView` imports, the draft props, and the `draft ?` minimize guard.
  Keep New, Import GPX, the saved-routes list, edit, reverse, export, activate, stop, and delete.
- [ ] Delete `src/features/routing/RouteDraftPanel.svelte`.
- [ ] `src/features/routing/index.ts`: drop the draft re-exports (draft-format, the Draft* types,
  `draftRoute`, and the route-draft-parse exports). Keep course-client, gpx-import, RoutesPanel,
  route-gpx, and routes-client.
- [ ] `src/features/route-edit/route-edit.ts`: remove `onUserEdit` and the now-purposeless `seeding`
  flag, and update the draft-referencing comments. Keep the Terra Draw manual editor itself.
- [ ] `src/widgets/chart-canvas/ChartCanvas.svelte`: remove the `onRouteEdited` prop and its comment.
- [ ] In `src/app/App.svelte`: remove the draft imports (the Draft types, `draftRoute`,
  `draftErrorMessage`, `formatDraftFuel`, `groupDraftFlags`, `routeDraftAvailable`); the draft state and
  helpers block (`draftAvailable`, `draftLoading`, `draftError`, `draftView`, `draftAbort`, `draftSeq`,
  `optimizeOriginal`, `optimizeUnchanged`, the tolerance and pad constants, `clearDraftState`,
  `vesselAreaBounds` and its constant, `runDraft`, `applyDraft`, `onDraftRoute`, `onOptimizeRoute`,
  `onCancelDraft`); the `clearDraftState()` calls inside `beginNewRoute`, `onSaveRoute`, and
  `onCancelRouteEdit`; the now-dead `onRouteEdited` and its wiring; the draft props on the RoutesPanel
  mount; and the now-dead imports `routesRoughlyEqual`, `nauticalMilesToMeters`, and `clampToWorld`
  (confirm with typecheck and lint). KEEP `chartsToken`, `serverFeatures`, the route-edit helpers, the
  Routes menu item, and the panel slot.
- [ ] Delete the five draft client and test files listed above.
- [ ] Run `npm run check`, `npm test`, `npm run lint`, and `npm run build`. Expected: green. Verify no
  orphaned imports or unused symbols remain (lint catches these).
- [ ] Commit the RoutesPanel and routing-file changes:
  `refactor(routing): reinline the manual edit shell and detach the draft panel`.
- [ ] Commit the App.svelte and client-file changes:
  `refactor(app): remove the AI route-draft seam`.

### Task C2: docs and version

**Files:** `CHANGELOG.md`, `README.md`, `package.json`.

**Steps:**
- [ ] `CHANGELOG.md`: add a dated entry noting the removal of the AI route-draft and optimize controls,
  with manual routing retained. Leave the historical draft entries intact.
- [ ] `README.md`: overwrite "What's New" to the removal release. There is no draft bullet to scrub
  elsewhere (the only crows-nest mention is the POI integration, which stays).
- [ ] `package.json`: bump the version (currently 0.11.0).
- [ ] Run the full gate. Commit: `docs: record the route-draft UI removal`.

---

## Integration

- Merge each repo's `feat/remove-route-draft` to its default branch after the gate is green and the diff
  is reviewed (companion and binnacle to main, crows-nest to its default).
- Delete the crows-nest `feat/m4-companion-cutover` branch (Task B4).
- Publishing and releases stay owner-run.

## Self-review

- Spec coverage: every item in the three scoping reports maps to a task here (companion crates, plugin
  seams, CI, and docs; crows-nest source, wiring, deps, comment rot, and docs including CLAUDE.md and
  development.md; binnacle draft UI, the App seam, route-edit detach, and docs). The shared POI infra,
  the notes integration, and all manual routing are explicitly kept.
- Risk controls: detach-before-delete is called out in B1 and C1; the regrep-before-delete guard is in
  B2; the gate runs at the end of every task; the RouteDraftPanel reinline is sequenced before its
  deletion; C1 merges all binnacle cross-file edits so the gate is never run against a half-detached
  state.
- Explicit carry-overs: the Save and X icon imports, `promptSaveName`, the local `promptSave` helper, and
  the `.editing` CSS are listed by name in C1 so none are silently dropped.
- CI safety: A1 fixes the companion CI workflow so it no longer references the deleted engine directory
  and adds tilecache CI coverage; "CI green" is an explicit A1 gate requirement.
- Comment rot: A2 covers stale comments in plugin.ts and the container runtime files; B2 covers stale
  comments in the ten retained crows-nest files listed in the task.
- Ambiguity resolved: the RouteDraftPanel residual manual-edit group is reinlined into RoutesPanel and
  the file is deleted (not kept as a slim shell), so there is one routes panel.
  `test/rhumb-interpolation.test.ts` is deleted in full (every test covers a removed function).
  The B4 branch deletion is conditional on the branch existing locally. The tilecache launch remains
  non-fatal. The companion README is fully rewritten, not spot-patched. The `signalk.recommends` edit in
  A3 explicitly drops `signalk-crows-nest` and keeps `signalk-binnacle`.
