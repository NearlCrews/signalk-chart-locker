# Chart Locker and regions rename Implementation Plan

> **For agentic workers:** execute with superpowers:subagent-driven-development. Two coupled
> cross-repo tasks, each ending green in BOTH affected repos. This is a rename: no behavior
> changes. The risk is the two wire contracts (the plugin route base path, and the position-warm
> settings route), which must change in lockstep across the plugin and the webapp, or the webapp
> cannot reach the plugin.

**Goal:** Rename the project identity from `signalk-binnacle-companion` / "Binnacle Companion" to
`signalk-chart-locker` / "Chart Locker", and rename the prewarm feature naming (symbols, strings,
and filenames) to regions, leaving both filesystem directories and the GitHub repo for a later
manual step.

**Repos:** `signalk-binnacle-companion` (the plugin and its Rust container) and `signalk-binnacle`
(the webapp consumer). `signalk-crows-nest` has zero references. `signalk-binnacle-chart-sources` is
a separate library and is NOT renamed.

**Tech stack:** plugin TypeScript (node --test via tsx), Rust container (cargo), webapp Svelte 5
(vitest, svelte-check).

## Global Constraints

- This is a pure rename: no logic, route behavior, or test assertions change except the renamed
  identifiers, paths, and strings. Every gate that was green stays green.
- The SignalK server mounts a plugin's HTTP routes at `/plugins/<plugin id>/`. The plugin id equals
  the package.json `name`. So the package name, `PLUGIN_ID`, and every hardcoded
  `/plugins/signalk-binnacle-companion/...` path in BOTH repos must become `signalk-chart-locker`
  together. A half-done change breaks the webapp to plugin connection.
- The GitHub repo does not exist yet, so there is no redirect concern: the GitHub-slug references
  (`homepage`, `repository.url`, `bugs.url` in package.json, `PLUGIN_REPO_URL` in plugin-id.ts, the
  README badge and clone URLs, and the geocode User-Agent in `container/tilecache/src/geocode.rs`)
  DO change to `signalk-chart-locker`, so the package is consistent with the repo the owner will
  create under the new name.
- **Do NOT change (leave exactly as is):**
  - The filesystem directories, until Task 3: the companion repo root
    `/home/dietpi/src/signalk-binnacle-companion` is renamed in Task 3 as the LAST step (after both
    rename tasks land and merge). The webapp `src/features/prewarm/` directory is NOT renamed in this
    plan at all (a separate later pass).
  - The historical design, spec, and milestone docs under `docs/superpowers/` (plans, specs, and
    the dated milestone and progress notes). Do not chase the rename through history. The two live
    plan and spec docs for the regions feature MAY keep their filenames; only update the live
    README, CLAUDE.md, and add a CHANGELOG entry.
  - The Rust crate name `binnacle-tilecache` (`container/tilecache/Cargo.toml`) and the
    `binnacle_tilecache` module path in tests: internal build artifact, higher churn, out of scope
    for this pass. (Flagged as a possible later cleanup.)
  - `signalk-binnacle-chart-sources` (dependency name) and `recommends: ["signalk-binnacle"]`.
  - The position-warm naming: `POSITION_WARM_REGION_ID` (value `'__position_warm__'`),
    `PositionWarmSettings`, `positionWarmBudgetBytes`, `position-warm.ts`, `position-warmer.ts`. These
    are a distinct sub-feature and KEEP their names.
- Writing style: no em dashes (colon, comma, or two sentences), Oxford commas, write "and" never the
  ampersand in displayed or written text, "chartplotter" one word, no AI-process talk.
- Build and test: companion `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and
  `cd container && cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo build --release --bin tilecache`. Webapp `npx vitest run`, `npm run check`, `npm run lint`,
  `npm run build`. The first Pi cargo build is slow: allow a long timeout.

---

### Task 1: Chart Locker identity (plugin id, package, container name, route base) across both repos

This task changes the plugin identity and the `/plugins/signalk-binnacle-companion` route base. The
plugin side and the webapp side must land together.

**Companion changes:**
- `package.json`: `name` to `signalk-chart-locker`; `signalk.displayName` to `Chart Locker`;
  reword `description` to drop "companion" framing (for example "Signal K plugin that runs a Rust
  container alongside the server for a boat-wide tile cache, a PMTiles chart provider, and saved
  downloadable map regions."); in `keywords` replace `"companion"` with `"tile-cache"` and add
  `"pmtiles"` (keep the `signalk-*` keywords). Change `homepage`, `repository.url`, and `bugs.url`
  to the `signalk-chart-locker` GitHub slug.
- Run `npm install` in the companion to regenerate `package-lock.json`: lines 2 and 8 carry the old
  `name`, and an install after the `name` change refreshes them. (The webapp `package.json` name does
  not change.)
- `src/shared/plugin-id.ts`: `PLUGIN_ID` to `'signalk-chart-locker'`; `PLUGIN_NAME` to
  `'Chart Locker'`; reword `PLUGIN_DESCRIPTION` if it names "Binnacle Companion"; change
  `PLUGIN_REPO_URL` to the `signalk-chart-locker` slug.
- `src/runtime/tilecache-config-push.ts:7`: `PLUGIN_PUBLIC_BASE` to
  `'/plugins/signalk-chart-locker'`.
- `src/charts/chart-registry.ts:9`: `SERVE_BASE` to `'/plugins/signalk-chart-locker/pmtiles'`.
- `src/runtime/tilecache-container.ts:8`: `TILECACHE_CONTAINER_NAME` to `'chart-locker-tilecache'`.
- Tests: `test/plugin-id.test.ts` (the `PLUGIN_ID` and `PLUGIN_NAME` assertions, and the
  `PLUGIN_REPO_URL` regex at line 15: change `/github\.com\/NearlCrews\/signalk-binnacle-companion/`
  to match `signalk-chart-locker`); `test/admin-gate.test.ts:19` (the `'/plugins/signalk-chart-locker/api'`
  path). Any other test asserting the old id or display name.
- Live docs: `README.md` (heading, intro, install command package name, the "Binnacle Companion"
  display name, and the GitHub badge URLs and the clone URL to the `signalk-chart-locker` slug),
  `CLAUDE.md` (the project name in the header and prose), and add a dated `CHANGELOG.md` entry
  "Renamed the plugin to Chart Locker (`signalk-chart-locker`)". Leave historical `docs/superpowers/`
  files.
- `.claude/agents/rust-signalk-expert.md` lines 4 and 17: change the `signalk-binnacle-companion`
  references to the `signalk-chart-locker` slug (repo-facing text).

**Container changes (string and comment only, keep the crate name and module path):**
- `container/tilecache/src/geocode.rs`: change the geocode User-Agent to a chart-locker User-Agent
  (harmless free text, like the existing one).
- `container/tilecache/src/state.rs:115`: the tile-fetch outbound
  `.user_agent("signalk-binnacle-companion-tilecache")` to a chart-locker User-Agent (also harmless
  free text).
- `container/tilecache/src/state.rs:86`: the doc-comment example path
  `/plugins/signalk-binnacle-companion` to `/plugins/signalk-chart-locker`.
- `container/tilecache/src/lib.rs:1`: the crate doc comment `//! The Binnacle Companion tile cache
  ...` to the Chart Locker display name.
- Do NOT touch the crate name `binnacle-tilecache` or the `binnacle_tilecache` module path.

**Webapp changes (must match the new path):**
- `src/shared/map/companion.ts:9`: `COMPANION_PATH` to `'/plugins/signalk-chart-locker'`.
- `src/shared/map/pmtiles.ts:134`: `COMPANION_PMTILES_PREFIX` to
  `'/plugins/signalk-chart-locker/pmtiles/'`.
- `src/shared/map/themed-map.ts`: the hardcoded path check and the "Binnacle Companion" comments.
- `src/shared/map/base-style.ts:14` and `src/shared/map/companion.ts:1`: the "Binnacle Companion"
  comments to "Chart Locker".
- `src/widgets/chart-canvas/ChartCanvas.svelte:241` and `:348`: the "Binnacle Companion" comments to
  "Chart Locker".
- Test URLs that hardcode the old path: `src/shared/map/pmtiles.test.ts`, `themed-map.test.ts`,
  `companion.test.ts`, `base-style.test.ts`, `src/features/prewarm/prewarm-client.test.ts`,
  `src/features/charts-management/charts-management-client.test.ts`.
- `CHANGELOG.md`: only if a live entry references the companion by the old name in a way that is now
  wrong; do not rewrite historical release notes.

**Verify:** both repos green. Then grep both repos with `grep -rn "signalk-binnacle-companion"`:
zero occurrences EXCEPT the historical `docs/superpowers/` files. Then grep both repos with
`grep -rn "Binnacle Companion"` (the display name): zero occurrences EXCEPT the historical
`docs/superpowers/` files. Commit in each repo: companion `refactor: rename the plugin to Chart
Locker (signalk-chart-locker)`, webapp `refactor: point the companion client at the chart-locker
plugin id`.

---

### Task 2: prewarm to regions (symbols, strings, filenames, and the position-warm route) across both repos

This task renames the prewarm feature naming to regions. The position-warm settings route changes
from `/api/prewarm/config` to `/api/position-warm/config`, a wire contract that must change on both
sides together.

**Symbol mapping (apply everywhere, including importers):**
- `PrewarmStore` to `RegionsStore`; `DEFAULT_PREWARM_STORE` to `DEFAULT_REGIONS_STORE`;
  `loadPrewarmStore` to `loadRegionsStore`; `savePrewarmStore` to `saveRegionsStore`.
- `PrewarmRequest` to `RegionsRequest`; `PrewarmResponse` to `RegionsResponse`; `PrewarmRouter` to
  `RegionsRouter`; `registerPrewarmRoutes` to `registerRegionsRoutes`.
- `PrewarmClient` to `RegionsClient`; `createPrewarmClient` to `createRegionsClient`.
- `PrewarmRectangle` to `RegionRectangle`; `createPrewarmRectangle` to `createRegionRectangle`.
- `prewarmableSources` to `regionSources`; `canPrewarm` to `canDownloadRegion`.
- `PrewarmPanel` to `RegionsPanel`.
- KEEP: `POSITION_WARM_REGION_ID`, `PositionWarmSettings`, `positionWarmBudgetBytes`, and every
  `addRegion`, `updateRegion`, `removeRegion`, `listRegions`, `SavedRegion`, `SavedRegionDto`,
  `RegionStatus`, `coveringSources`, `regionsFreeBytes`, and `exceedsRegionsFree` (already
  region-named).

**Filename `git mv` (keep the directories):**
- Companion source: `git mv src/runtime/prewarm-store.ts src/runtime/regions-store.ts`;
  `git mv src/http/prewarm-routes.ts src/http/regions-routes.ts`.
- Companion tests: three purpose-named renames, each keeping git history. Do NOT merge any test
  files: `test/geocode-proxy.test.ts` already tests the same `prewarm-routes.ts` module as a separate
  third file, so one-test-file-per-module is not an invariant here, and a merge would drop history
  and add hand-editing risk to a mechanical rename.
  - `git mv test/prewarm-store.test.ts test/regions-store.test.ts` (the store suite).
  - `git mv test/region-routes.test.ts test/regions-crud.test.ts` (the region CRUD and reconcile
    suite).
  - `git mv test/prewarm-routes.test.ts test/regions-routes.test.ts` (the route-mounting and
    position-warm config-floor suite).
  After each `git mv`, update the file's `describe(...)` blocks and its `/api/position-warm/config`
  assertions (see the position-warm route section below).
- Webapp: `src/features/prewarm/PrewarmPanel.svelte` to `RegionsPanel.svelte`;
  `prewarm-client.ts` to `regions-client.ts`; `prewarm-draw.ts` to `regions-draw.ts` (plural, to
  match the `regions-client.ts`, `regions-routes.ts`, and `regions-store.ts` siblings; the symbols
  `RegionRectangle` and `createRegionRectangle` stay singular, since each is one rectangle);
  `prewarm-client.test.ts` to `regions-client.test.ts`;
  `prewarm-panel.svelte.test.ts` to `regions-panel.svelte.test.ts`. The directory
  `src/features/prewarm/` is NOT renamed. `estimate.ts` and `estimate.test.ts` keep their names.
- Update `src/features/prewarm/index.ts` (the `PrewarmPanel` export) to export `RegionsPanel` from
  the new file. Update EVERY importer found by grep in both repos, not just the webapp ones. The
  companion importers that break otherwise:
  - `src/runtime/position-warm.ts:6` imports `PositionWarmSettings, SavedRegion` from
    `./prewarm-store.js`: repoint to `./regions-store.js`.
  - `test/geocode-proxy.test.ts:3` imports `registerPrewarmRoutes, PrewarmRouter, PrewarmRequest,
    PrewarmResponse` from `../src/http/prewarm-routes.js` and calls `registerPrewarmRoutes` at lines
    27, 38, and 57: rename the symbols and the path, and update the test-name string at line 25.
  - `test/position-warm.test.ts:4-5` imports `DEFAULT_PREWARM_STORE, SavedRegion` from
    `prewarm-store.js`: rename the symbol and repoint the path.
  - `test/position-warmer.test.ts:4-5, :11` imports `DEFAULT_PREWARM_STORE, PrewarmStore,
    SavedRegion`: rename the symbols and repoint the path.
  Webapp importers: `App.svelte`, `estimate.ts`, and the renamed test files.

**The position-warm settings route (wire contract, both sides together):**
- Companion `regions-routes.ts`: change the two route mounts `'/api/prewarm/config'` to
  `'/api/position-warm/config'` (GET and POST). The handler logic and the store access are unchanged.
- Webapp `regions-client.ts`: change the two `url('/prewarm/config')` call sites to
  `url('/position-warm/config')`.
- Test assertions of that path change too, not just the mounts and the client: in the renamed
  `test/regions-crud.test.ts` (was `region-routes.test.ts`) at lines 215 and 228, and in the renamed
  `test/regions-routes.test.ts` (was `prewarm-routes.test.ts`) at lines 35, 41, and 46.
- Webapp `src/features/prewarm/settings-payload.ts:1`: a comment documents `/api/prewarm/config`;
  update it to `/api/position-warm/config`. This file is the position-warm settings payload builder,
  so its filename stays (not prewarm-based); only the comment changes. Add it to the Task 2 edit list.
- The `/api/regions/*`, `/api/cache/stats`, and `/api/geocode` routes are unchanged.

**On-disk store file (`STORE_FILE`), an accepted pre-publish data reset:**
- `src/runtime/prewarm-store.ts:63` names the on-disk file `'prewarm.json'`: rename it to
  `'regions.json'`. Update the six literals in the renamed `test/regions-store.test.ts` (lines 14,
  60, 75, 84, 97, and 125). This is an accepted pre-publish data reset, consistent with the
  data-directory change, not a silent behavior change: the `PLUGIN_ID` change in Task 1 already moves
  the data directory (`getDataDirPath` is keyed by the plugin id), so the old data directory and its
  `prewarm.json` are already orphaned. Renaming the file in the new data directory adds no further
  data loss and keeps the grep clean.

**UI strings and ids:**
- Webapp `App.svelte`: the panel id `'prewarm'` to `'regions'` (the `activePanel`, `togglePanel`,
  and the `{#if activePanel === ...}` block, the button id), and the `PrewarmPanel` import to
  `RegionsPanel`.
- `RegionsPanel.svelte`: the "No prewarmable sources found in the registry." string to "No
  downloadable sources cover this area." Update the Terra Draw `prefixId` in `regions-draw.ts` from
  `'binnacle-prewarm-draw'` to `'chart-locker-region-draw'` (a self-contained layer id prefix).
- The `describe(...)` blocks in the renamed test files ("prewarm gate", "prewarm client", "prewarm
  estimate") to their regions equivalents.

**Drive the remaining edits off the grep, not a hand list:** update EVERY `prewarm` and `Prewarm`
occurrence in both repos EXCEPT the historical `docs/superpowers/` files, the `CHANGELOG.md`
historical entries, and the kept `position-warm` naming. Update comments to "regions" where they
describe the region feature; leave comments that genuinely describe position-warm. The comment and
string occurrences beyond the symbols, filenames, and routes above:
- Companion comments: `src/runtime/json-state.ts:2`, `src/charts/overrides.ts:3`,
  `src/shared/admin-gate.ts:7`, `src/plugin/plugin.ts:138` and `:273`, and
  `container/tilecache/src/warm.rs:22`.
- Webapp comments and strings: `src/shared/companion/companion-api.ts:2`,
  `src/features/charts-management/charts-management-client.ts:2`, `src/features/prewarm/estimate.ts:24`
  (the word "prewarmable"), and `src/widgets/chart-canvas/ChartCanvas.svelte:136`.
- Test temp-directory prefixes in the renamed `test/regions-store.test.ts`: `'prewarm-store-'` and
  `'prewarm-'` become `'regions-store-'`.
- Live prose to EDIT (not leave): companion `README.md` lines 30, 42, 44, 47, and 62, and companion
  `CLAUDE.md` lines 58 and 62.

**Verify:** both repos green (companion `npm test`, `typecheck`, `lint`, `build`, and the cargo
suite since `regions-routes.ts` and `regions-store.ts` are imported by `plugin.ts`; webapp `vitest`,
`check`, `lint`, `build`). Then grep both repos for `prewarm` and `Prewarm`: zero occurrences except
the historical `docs/superpowers/` files, the `CHANGELOG.md` historical entries in both repos, and
the deliberately-kept `position-warm` naming. Commit in each repo: companion `refactor: rename the
prewarm feature to regions`, webapp `refactor: rename the prewarm panel and client to regions`.

---

### Task 3: Rename the companion repo directory (LAST step, after Tasks 1 and 2 merge)

Only after Tasks 1 and 2 are merged to their default branches and all gates are green: rename the
companion repo root directory `/home/dietpi/src/signalk-binnacle-companion` to
`/home/dietpi/src/signalk-chart-locker`.

- This is a plain directory move (`mv`), not a `git mv`: the git repo is self-contained and moves
  intact. Nothing `file:`-links to the companion directory (the webapp depends on
  `signalk-binnacle-chart-sources`, not the companion), so no consumer path breaks.
- It is disruptive to an ACTIVE session: every absolute path under the old directory (the working
  directory, the scratch and ledger paths, the Claude memory project key) changes. So it runs last,
  as its own step, and is confirmed with the owner before execution. It does not need a code review
  or a gate run; after the move, re-run the companion gates once from the new path to confirm the
  build still works in the new location.
- The webapp `src/features/prewarm/` directory is out of scope and stays.

---

## Self-Review

- Both wire contracts changed in lockstep: the `/plugins/signalk-chart-locker` base (Task 1) and the
  `/api/position-warm/config` route (Task 2) match between the plugin and the webapp.
- The GitHub slug changes everywhere it appears: package.json `homepage`, `repository.url`, and
  `bugs.url`, `PLUGIN_REPO_URL` and its test regex, the README badge URLs and clone URL, the geocode
  and tile-fetch User-Agents in the container, and the `.claude/agents/` doc all become
  `signalk-chart-locker`, so the package, the container, and the docs are internally consistent with
  the repo the owner will create under the new name.
- The keep-list is honored: the Rust crate name `binnacle-tilecache` and the `binnacle_tilecache`
  module path, the filesystem directories until Task 3, the historical `docs/superpowers/` and
  `CHANGELOG.md` history, `signalk-binnacle-chart-sources`, `recommends signalk-binnacle`, the webapp
  `src/features/prewarm/` directory, and all position-warm naming (including the
  `POSITION_WARM_REGION_ID` value `'__position_warm__'`) are untouched.
- No behavior changed except the accepted pre-publish data reset (`STORE_FILE` and the data
  directory both move): only identifiers, paths, strings, and filenames otherwise. All
  previously-green gates are green in both repos.
- A final grep shows no `signalk-binnacle-companion` or `Binnacle Companion` outside the historical
  `docs/superpowers/` files, and no `prewarm` or `Prewarm` outside the historical `docs/superpowers/`
  files, the `CHANGELOG.md` history, and the kept `position-warm` naming.
