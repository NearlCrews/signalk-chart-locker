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
`npm run build`; for the companion also `cd container && cargo test --workspace`,
`cargo clippy --workspace --all-targets -- -D warnings`, and `cargo build --release --bin tilecache`.

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

### Task A1: delete the routing crates and the prep tool

**Files (delete):**
- `container/engine/`, `container/gpkg/`, `container/localprovider/`, `container/router/`,
  `container/storage-spike/` (the whole crate dirs)
- `container/prep/` (the Python plus GDAL prep tool, not a workspace member)
- `container/Dockerfile` (the router image) and `container/prep/Dockerfile`

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
- [ ] Run `cd container && cargo build --release --bin tilecache` and `cargo test --workspace` and
  `cargo clippy --workspace --all-targets -- -D warnings`. Expected: green, workspace now is tilecache
  only.
- [ ] Commit: `refactor(container): drop the routing crates and the prep tool, keep the tile cache`.

### Task A2: detach the router lifecycle and the bridge from the plugin

**Files:**
- Delete: `src/bridge/route-on-water-bridge.ts` (then the empty `src/bridge/` dir),
  `src/runtime/router-container.ts`, `test/router-container.test.ts`,
  `test/route-on-water-bridge.test.ts`, `test/types.test.ts` (tests only the removed RouteOnWaterResult).
- Edit: `src/plugin/plugin.ts`, `src/shared/types.ts`, `test/helpers.ts`, `test/plugin.test.ts`,
  `test/plugin-integration.test.ts`, and the comment-only references in
  `src/runtime/container-manager.ts` and `src/runtime/tilecache-container.ts`.

**Steps:**
- [ ] In `src/plugin/plugin.ts`: remove the router-container and route-on-water-bridge imports; remove
  the `imageTag` config field and the `launched` flag; remove from `doStart` the router `ensureRunning`,
  `resolveContainerAddress`, the throw, and `installRouteOnWaterBridge(createRouterBridge(...))`; make the
  tilecache the primary container; rewrite the status lines so they report the tilecache only (the router
  `address` variable disappears); remove from `doStop` the `removeRouteOnWaterBridge()` call and the
  `if (launched) ... stop(ROUTER_CONTAINER_NAME)` block (keep the tilecache stop block); remove the
  `imageTag` property from `schema()` (keep `tilecacheImageTag`, `tilecacheCacheCapBytes`,
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
  to the tile cache and PMTiles reality.
- [ ] `README.md`: rewrite "What it does", "Features", and "What's New" to the tile cache and PMTiles
  provider only.
- [ ] `CHANGELOG.md`: add a dated entry recording the router-engine removal and the tile-cache-only
  scope. `package.json`: bump the version and refresh `signalk.recommends`.
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
  `test/shared-regions.test.ts`
- Docs: `docs/route-draft-api.md`

**Steps:**
- [ ] Before deleting `src/shared/regions.ts` and `src/shared/with-deadline.ts`, re-grep to confirm no
  non-route-draft, non-test importer remains.
- [ ] Delete all the files and directories listed above.
- [ ] `src/geo/position-utilities.ts`: remove `rhumbDistanceMeters` and `sampleRhumbLeg` (sole callers
  were route-draft); KEEP `distanceMeters` and the rest. Update `test/rhumb-interpolation.test.ts`
  accordingly (drop the tests for the removed functions; keep the file if it still tests kept functions,
  else delete it).
- [ ] `test/config-reducer.test.ts` and `test/plugin.test.ts`: remove the route-draft assertions.
- [ ] Run `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. Expected: green.
- [ ] Commit: `refactor: remove the route-draft feature source, assets, and tests`.

### Task B3: drop the route-draft dependencies and update the docs

**Files:** `package.json`, `README.md`, `CHANGELOG.md`.

**Steps:**
- [ ] `package.json`: drop `@mapbox/vector-tile` and `pbf` (only `vector-tile-client.ts` used them);
  remove the `build:boundaries` script. Keep `handlebars` and `lru-cache`. Refresh the lockfile with
  `npm install`. Bump the version and refresh `signalk.recommends`.
- [ ] `README.md`: remove the route-draft sections (What's New, the beta warning, the feature bullet, the
  config, the API-guide link, and the EMODnet mention). Overwrite "What's New" to the removal release.
- [ ] `CHANGELOG.md`: add a dated removal entry. Leave the historical entries intact.
- [ ] Run the full gate again. Commit: `docs: drop the route-draft deps and update the docs`.

### Task B4: delete the mooted M4 cutover branch

**Steps:**
- [ ] After Repo B is merged, delete the stale unmerged branch in crows-nest:
  `git branch -D feat/m4-companion-cutover`. It was the route-draft-via-companion cutover, now removed.

---

## Repo C: signalk-binnacle (remove the AI draft UI, keep all manual routing)

Source of the map: the binnacle scoping report. Manual routing, GPX, and activation are independent of
the draft. The entanglement is `RouteDraftPanel.svelte` (it also holds the manual Save and Cancel edit
shell) and the App.svelte draft seam.

### Task C1: reinline the manual edit shell and detach the draft UI

Do the detach edits before deleting `RouteDraftPanel.svelte`.

**Files:** `src/features/routing/RoutesPanel.svelte`, `src/features/routing/RouteDraftPanel.svelte`
(delete after reinline), `src/features/routing/index.ts`, `src/features/route-edit/route-edit.ts`,
`src/widgets/chart-canvas/ChartCanvas.svelte`.

**Steps:**
- [ ] In `RoutesPanel.svelte`: replace the `<RouteDraftPanel>` wrapper with the residual non-draft manual
  edit group (the Save and Cancel strip plus the RouteEditPlan and the "Tap the chart to add waypoints"
  hint that lived inside RouteDraftPanel's `{#if working}` block). Drop the `RouteDraftPanel` and
  `DraftView` imports, the draft props, and the `draft ?` minimize guard. Keep New, Import GPX, the
  saved-routes list, edit, reverse, export, activate, stop, and delete.
- [ ] Delete `src/features/routing/RouteDraftPanel.svelte`.
- [ ] `src/features/routing/index.ts`: drop the draft re-exports (draft-format, the Draft* types,
  `draftRoute`, and the route-draft-parse exports). Keep course-client, gpx-import, RoutesPanel,
  route-gpx, and routes-client.
- [ ] `src/features/route-edit/route-edit.ts`: the `onUserEdit` callback existed mainly to drop draft
  mode on a hand-edit and is now dead; remove it and the now-purposeless `seeding` flag, and update the
  draft-referencing comments. Keep the Terra Draw manual editor itself.
- [ ] `src/widgets/chart-canvas/ChartCanvas.svelte`: remove the `onRouteEdited` prop and its comment.
- [ ] Run `npm run check`, the test runner, and `npm run lint`. Expected: green (App.svelte still
  references draft state, fixed in C2; if needed, sequence C2 before the gate, but the detach here should
  compile against the still-present App seam if App is edited in the same task. Prefer doing C1 and C2 as
  one commit if the cross-file references require it.)
- [ ] Commit: `refactor(routing): reinline the manual edit shell and detach the draft panel`.

### Task C2: remove the App.svelte draft seam and the draft client files

**Files:** `src/app/App.svelte`; delete `src/features/routing/route-draft-client.ts`,
`route-draft-parse.ts`, `draft-format.ts`, `route-draft-client.test.ts`, `draft-format.test.ts`.

**Steps:**
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
- [ ] Delete the five draft client and test files.
- [ ] Run `npm run check`, the test runner, `npm run lint`, and `npm run build`. Expected: green. Verify
  no orphaned imports or unused symbols remain (lint catches these).
- [ ] Commit: `refactor(app): remove the AI route-draft seam`.

### Task C3: docs and version

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
  seams, and docs; crows-nest source, wiring, deps, and docs; binnacle draft UI, the App seam, route-edit
  detach, and docs). The shared POI infra, the notes integration, and all manual routing are explicitly
  kept.
- Risk controls: detach-before-delete is called out in B1 and C1; the regrep-before-delete guard is in
  B2; the gate runs at the end of every task; the RouteDraftPanel reinline is sequenced before its
  deletion.
- Ambiguity resolved: the RouteDraftPanel residual manual-edit group is reinlined into RoutesPanel and
  the file is deleted (not kept as a slim shell), so there is one routes panel.
