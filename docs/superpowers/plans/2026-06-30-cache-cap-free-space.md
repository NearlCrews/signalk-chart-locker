# Cache-cap free-space awareness and 5 GiB increments

**Goal:** The configuration panel's cache-size-cap field learns the free space on the Signal K data
directory, seeds its default from it, warns when the cap exceeds free space, and moves in 5 GiB
increments. The generated schema form gains the same 5 GiB granularity and shares one derivation of
the free-space default.

**Architecture:** A new browser-safe shared module holds the cache-cap bounds and the pure
free-space-to-default math, imported by both the plugin runtime and the federated panel so they can
never drift. A new admin-gated plugin route exposes the detected free space to the browser panel,
which cannot stat the server filesystem itself. The panel fetches it once on mount, seeds the
default when the plugin is unconfigured, and shows a free-space line plus an over-budget warning.

**Tech stack:** TypeScript, node:fs statfsSync (runtime only), React 19 (panel), node --test via tsx.

## Global constraints

- No em dashes anywhere. Oxford commas. Write "and", never the ampersand, in displayed and written
  text. "chartplotter" is one word. No AI-process talk in comments, commits, or docs.
- SI internal, convert only at a display edge. Cache sizes are whole GiB in config and in the panel;
  no unit conversion in the panel.
- The container image tag is pinned to the plugin version. This change does not touch `container/`,
  so no version bump is required by the container rule.
- The runtime image carries no new native libraries; statfsSync is node core.
- The route must fail closed behind `ensureApiAdminGate(app)`, exactly like the regions routes.
- The panel is a Module Federation remote; the shared module it imports must not pull node core into
  the browser bundle (no `node:fs`, no runtime imports).

---

## File structure

- Create `src/shared/cache-cap.ts`: pure constants and math, no node imports. Single source of the
  cache-cap bounds, the 5 GiB step, the static fallback, and `deriveDefaultCapGiB`.
- Create `src/http/cache-info-route.ts`: the admin-gated `GET /api/cache-info` route.
- Create `src/panel/hooks/use-cache-info.ts`: the panel's one-shot fetch of the route.
- Modify `src/runtime/tilecache-container.ts`: source `DEFAULT_CACHE_CAP_GIB` from the shared static
  default so the runtime byte math and the panel agree.
- Modify `src/plugin/plugin.ts`: schema() uses `deriveDefaultCapGiB` and the shared bounds
  (`minimum: 5, multipleOf: 5`), ui:help copy mentions 5 GiB steps, and `registerWithRouter` mounts
  the new route.
- Modify `src/panel/config-types.ts`: re-export the cache-cap bounds and step from the shared module
  instead of redefining them; keep the regions constants local.
- Modify `src/panel/normalize-config.ts`: clamp the cap to the shared `[min, max]` (no forced
  rounding, so an existing stored value is preserved).
- Modify `src/panel/components/PluginConfigurationPanel.tsx`: consume `useCacheInfo`, seed the
  default when unconfigured, pass `step`, and render the free-space line and the over-budget warning
  inside the field hint.
- Modify `tsconfig.panel.json`: add `src/shared/cache-cap.ts` to `include`.
- Create tests: `test/cache-cap.test.ts` (shared math), `test/cache-info-route.test.ts` (route),
  and extend the panel normalize test for the new min.

---

### Task 1: Shared cache-cap module

**Files:**
- Create: `src/shared/cache-cap.ts`
- Test: `test/cache-cap.test.ts`

**Interfaces:**
- Produces: `CACHE_CAP_MIN_GIB = 5`, `CACHE_CAP_MAX_GIB = 1024`, `CACHE_CAP_STEP_GIB = 5`,
  `CACHE_CAP_STATIC_DEFAULT_GIB = 10`, `floorToStep(value: number, step: number): number`,
  `deriveDefaultCapGiB(freeGiB: number): number`.

Content:

```ts
/**
 * Cache-cap bounds and the free-space-to-default derivation, shared by the plugin runtime and the
 * federated configuration panel so a single definition governs the schema, the cache-info route, and
 * the panel field. This module is browser safe: it imports nothing from node, so the panel bundle can
 * import it without pulling node core in.
 */

/** Smallest cache cap the plugin accepts, in whole GiB. */
export const CACHE_CAP_MIN_GIB = 5
/** Largest cache cap the plugin accepts, in whole GiB. */
export const CACHE_CAP_MAX_GIB = 1024
/** The increment the cache-cap slider and stepper move by, in GiB. */
export const CACHE_CAP_STEP_GIB = 5
/** The cap used when free space cannot be detected, in GiB. A multiple of the step. */
export const CACHE_CAP_STATIC_DEFAULT_GIB = 10

/** Round a value down to the nearest multiple of `step`, never below zero. A non-finite value or a
 *  non-positive step yields 0, so callers clamp to the minimum afterward. */
export function floorToStep (value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0
  return Math.floor(value / step) * step
}

/** The recommended cap for a filesystem with `freeGiB` free: about 80 percent of free space, floored
 *  to the 5 GiB step to leave headroom, and never below the minimum. A non-finite input yields the
 *  minimum. */
export function deriveDefaultCapGiB (freeGiB: number): number {
  if (!Number.isFinite(freeGiB)) return CACHE_CAP_MIN_GIB
  return Math.max(CACHE_CAP_MIN_GIB, floorToStep(freeGiB * 0.8, CACHE_CAP_STEP_GIB))
}
```

- [ ] Step 1: Write `test/cache-cap.test.ts` asserting: `floorToStep(37, 5) === 35`, `floorToStep(5, 5) === 5`,
  `floorToStep(NaN, 5) === 0`, `deriveDefaultCapGiB(120) === 95` (120*0.8=96 -> floor5 95),
  `deriveDefaultCapGiB(1) === 5` (0.8 -> floor5 0 -> min 5), `deriveDefaultCapGiB(NaN) === 5`,
  `deriveDefaultCapGiB(0) === 5`.
- [ ] Step 2: Run `node --import tsx --test test/cache-cap.test.ts`, expect FAIL (module missing).
- [ ] Step 3: Create `src/shared/cache-cap.ts` as above.
- [ ] Step 4: Run the test, expect PASS.
- [ ] Step 5: Commit.

Verify: `deriveDefaultCapGiB(120)`: 120*0.8 = 96, floorToStep(96,5) = 95, max(5,95) = 95. Correct.

---

### Task 2: Route the free space to the panel

**Files:**
- Create: `src/http/cache-info-route.ts`
- Test: `test/cache-info-route.test.ts`
- Modify: `src/plugin/plugin.ts` (registerWithRouter)

**Interfaces:**
- Consumes: `ensureApiAdminGate` from `../shared/admin-gate.js`, `deriveDefaultCapGiB` and
  `CACHE_CAP_STATIC_DEFAULT_GIB` from `../shared/cache-cap.js`.
- Produces: `registerCacheInfoRoute(router: CacheInfoRouter, app: ServerAPI, deps?: { dataDir?: string, statfs?: (path: string) => { bsize: number, bavail: number } }): boolean`.
  Route `GET /api/cache-info` responds `{ freeGiB: number | null, recommendedCapGiB: number }`.

Design notes:
- Mirror `registerRegionsRoutes`: gate first (`if (!ensureApiAdminGate(app)) return false`), resolve
  `dataDir` from deps or `app.getDataDirPath()`, inject `statfs` for tests (default `statfsSync`).
- On a statfs failure, respond `{ freeGiB: null, recommendedCapGiB: CACHE_CAP_STATIC_DEFAULT_GIB }`
  with status 200, so the panel always gets a usable recommendation and shows no free-space line.
- `freeGiB = Math.floor((bsize * bavail) / 1024 ** 3)`, `recommendedCapGiB = deriveDefaultCapGiB(freeGiB)`.
- The route type interface mirrors the `RegionsRouter` narrowing (`get(path, handler)` only).

```ts
/** The admin-gated cache-info route. It reports the free space on the Signal K data directory and the
 *  recommended cache cap, so the browser configuration panel can seed its default and warn when the
 *  cap exceeds free space. The panel cannot stat the server filesystem itself. Mounted only behind the
 *  admin gate, so an ungatable server leaves it unmounted (fail closed). */

import { statfsSync } from 'node:fs'
import type { ServerAPI } from '@signalk/server-api'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
import { CACHE_CAP_STATIC_DEFAULT_GIB, deriveDefaultCapGiB } from '../shared/cache-cap.js'

export interface CacheInfoRequest { params: Record<string, string> }
export interface CacheInfoResponse {
  status (code: number): CacheInfoResponse
  json (value: unknown): void
}
export interface CacheInfoRouter {
  get (path: string, handler: (req: CacheInfoRequest, res: CacheInfoResponse) => void): void
}

interface Deps {
  dataDir?: string
  statfs?: (path: string) => { bsize: number, bavail: number }
}

/** Mount the cache-info route behind the admin gate. Returns whether it was mounted. */
export function registerCacheInfoRoute (router: CacheInfoRouter, app: ServerAPI, deps: Deps = {}): boolean {
  if (!ensureApiAdminGate(app)) return false
  const dataDir = deps.dataDir ?? (app as unknown as { getDataDirPath(): string }).getDataDirPath()
  const statfs = deps.statfs ?? statfsSync

  router.get('/api/cache-info', (_req, res) => {
    try {
      const { bsize, bavail } = statfs(dataDir)
      const freeGiB = Math.floor((bsize * bavail) / (1024 ** 3))
      res.status(200).json({ freeGiB, recommendedCapGiB: deriveDefaultCapGiB(freeGiB) })
    } catch {
      res.status(200).json({ freeGiB: null, recommendedCapGiB: CACHE_CAP_STATIC_DEFAULT_GIB })
    }
  })
  return true
}
```

- [ ] Step 1: Write `test/cache-info-route.test.ts`: a fake router captures the handler; injected
  `statfs` returning `{ bsize: 4096, bavail: 31457280 }` (120 GiB) yields
  `{ freeGiB: 120, recommendedCapGiB: 95 }`; an injected `statfs` that throws yields
  `{ freeGiB: null, recommendedCapGiB: 10 }`; a fake app whose admin gate fails leaves the route
  unmounted and `registerCacheInfoRoute` returns false. Reuse the admin-gate fake from the regions
  route test (read `test/` for the existing helper before writing a new one).
- [ ] Step 2: Run the test, expect FAIL (module missing).
- [ ] Step 3: Create `src/http/cache-info-route.ts` as above.
- [ ] Step 4: In `src/plugin/plugin.ts`, import `registerCacheInfoRoute` and its router type, and mount
  it in `registerWithRouter` alongside the other groups:
  `registerCacheInfoRoute(router as unknown as CacheInfoRouter, app)`.
- [ ] Step 5: Run the test, expect PASS.
- [ ] Step 6: Commit.

---

### Task 3: Schema uses the shared helper and 5 GiB steps

**Files:**
- Modify: `src/runtime/tilecache-container.ts:37`
- Modify: `src/plugin/plugin.ts` (schema free-space block and cacheCapGiB field and ui:help)

- [ ] Step 1: In `src/runtime/tilecache-container.ts`, replace the literal
  `export const DEFAULT_CACHE_CAP_GIB = 8` with an import-backed constant:
  `import { CACHE_CAP_STATIC_DEFAULT_GIB } from '../shared/cache-cap.js'` and
  `export const DEFAULT_CACHE_CAP_GIB = CACHE_CAP_STATIC_DEFAULT_GIB`. Keep the exported name so its
  importers are untouched.
- [ ] Step 2: In `src/plugin/plugin.ts` schema(), import
  `import { CACHE_CAP_MAX_GIB, CACHE_CAP_MIN_GIB, CACHE_CAP_STEP_GIB, deriveDefaultCapGiB } from '../shared/cache-cap.js'`
  and replace the free-space default derivation:
  ```ts
  let capDefaultGiB = DEFAULT_CACHE_CAP_GIB
  try {
    const dataDir = (app as unknown as { getDataDirPath: () => string }).getDataDirPath()
    const { bsize, bavail } = statfsSync(dataDir)
    const freeGiB = Math.floor((bsize * bavail) / (1024 ** 3))
    capDefaultGiB = deriveDefaultCapGiB(freeGiB)
  } catch { /* keep the static default */ }
  ```
- [ ] Step 3: Set the cacheCapGiB field to `multipleOf: CACHE_CAP_STEP_GIB`, `minimum: CACHE_CAP_MIN_GIB`,
  `maximum: CACHE_CAP_MAX_GIB`, `default: capDefaultGiB`.
- [ ] Step 4: Update the cacheCapGiB `ui:help` to note it moves in 5 GiB steps and defaults to about
  80 percent of detected free space, floored to 5 GiB. Keep the existing external-drive caveat. No
  em dashes, no ampersand.
- [ ] Step 5: Run `npm run typecheck` and `npm test`, expect PASS.
- [ ] Step 6: Commit.

---

### Task 4: Panel bounds from the shared module

**Files:**
- Modify: `src/panel/config-types.ts`
- Modify: `src/panel/normalize-config.ts`
- Modify: `tsconfig.panel.json`
- Test: extend the existing panel normalize test if one exists, else add `test/normalize-config.test.ts`

- [ ] Step 1: In `tsconfig.panel.json`, add `"src/shared/cache-cap.ts"` to `include`.
- [ ] Step 2: In `src/panel/config-types.ts`, delete the local `CACHE_CAP_MIN_GIB`,
  `CACHE_CAP_MAX_GIB`, and `CACHE_CAP_DEFAULT_GIB`, and re-export from the shared module:
  `export { CACHE_CAP_MAX_GIB, CACHE_CAP_MIN_GIB, CACHE_CAP_STEP_GIB } from '../shared/cache-cap.js'`
  and `export { CACHE_CAP_STATIC_DEFAULT_GIB as CACHE_CAP_DEFAULT_GIB } from '../shared/cache-cap.js'`.
  Keep the regions constants as they are. Update any comment that cited the old 8 GiB fallback or the
  1 GiB minimum.
- [ ] Step 3: In `src/panel/normalize-config.ts`, the cap clamp already reads
  `CACHE_CAP_MIN_GIB`/`CACHE_CAP_MAX_GIB`/`CACHE_CAP_DEFAULT_GIB`; no logic change is needed because
  they now resolve to 5, 1024, and 10. Do not add step rounding: an existing stored value such as 8
  must display verbatim, not snap.
- [ ] Step 4: Add or extend a test asserting `normalizeConfig({ tileCache: { cacheCapGiB: 2 } })`
  clamps to 5, `normalizeConfig({})` yields `cacheCapGiB: 10`, and a value of 8 is preserved.
- [ ] Step 5: Run `npm run typecheck` and `npm test`, expect PASS.
- [ ] Step 6: Commit.

---

### Task 5: Panel free-space fetch, seed, warning, and step

**Files:**
- Create: `src/panel/hooks/use-cache-info.ts`
- Modify: `src/panel/components/PluginConfigurationPanel.tsx`

**Interfaces:**
- Produces: `useCacheInfo(): { freeGiB: number | null, recommendedCapGiB: number | null, error: string | null }`.
  Fetches `/plugins/${PLUGIN_ID}/api/cache-info` once on mount with `credentials: 'same-origin'` and
  the shared `PANEL_REQUEST_TIMEOUT_MS`, aborts on unmount, never throws.

- [ ] Step 1: Write `src/panel/hooks/use-cache-info.ts`. Mirror the fetch shape in `use-status.ts`
  (same-origin, `AbortSignal.any([unmountController.signal, AbortSignal.timeout(PANEL_REQUEST_TIMEOUT_MS)])`,
  a canceled ref, catch-to-error). Build the URL from `PLUGIN_ID` (`../../shared/plugin-id.js`):
  `const CACHE_INFO_URL = \`/plugins/${PLUGIN_ID}/api/cache-info\``. Parse
  `{ freeGiB, recommendedCapGiB }` defensively: accept `freeGiB` as a finite number or null, and
  `recommendedCapGiB` as a finite number else null. One fetch, no interval.
- [ ] Step 2: In `PluginConfigurationPanel.tsx`, call `const { freeGiB, recommendedCapGiB } = useCacheInfo()`.
- [ ] Step 3: Seed the default once when unconfigured. Add a `seededRef = useRef(false)` and an effect:
  ```ts
  useEffect(() => {
    if (seededRef.current) return
    if (!unconfigured) return
    if (recommendedCapGiB === null) return
    if (dirty) return
    if (state.tileCache.cacheCapGiB !== CACHE_CAP_DEFAULT_GIB) return
    seededRef.current = true
    dispatch({ type: 'setCacheCapGiB', giB: recommendedCapGiB })
  }, [unconfigured, recommendedCapGiB, dirty, state.tileCache.cacheCapGiB, dispatch])
  ```
  This runs at most once, only for a never-configured plugin whose field still holds the static
  default, so it never clobbers a value the user typed or a stored value.
- [ ] Step 4: Pass `step={CACHE_CAP_STEP_GIB}` to the cache-cap `RangeField` (import the constant).
- [ ] Step 5: Compose the free-space line and the over-budget warning into the cache-cap field hint.
  Below the existing hint prose, add, when `freeGiB !== null`, a line
  `{freeGiB} GiB free on the Signal K data directory.` and, when
  `freeGiB !== null && state.tileCache.cacheCapGiB > freeGiB`, a warning element (use the existing
  `S.errorBanner` or a warn token, `role='alert'`) reading
  `Cache cap exceeds free space. Reduce it, or move the cache to an external drive under Advanced.`
  Keep the seed effect and the warning reading the same `state.tileCache.cacheCapGiB`.
- [ ] Step 6: Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`, expect all PASS
  and `public/remoteEntry.js` rebuilt.
- [ ] Step 7: Commit.

---

## Notes for review

- Trust boundary: the new route is admin-gated, read-only, returns no filesystem paths (only a GiB
  integer and a recommendation), and reuses the exact gate the regions routes use. Confirm it leaks
  nothing more than free space and cannot be reached unauthenticated.
- Drift: the schema default, the route recommendation, and the panel bounds all resolve through
  `src/shared/cache-cap.ts`. Confirm no second definition of the bounds or the 0.8 factor survives.
- Backward compatibility: raising the minimum to 5 and the step to 5 must not rewrite an existing
  stored cap; normalize clamps but does not round. Confirm.
- Browser safety: `src/shared/cache-cap.ts` must not import node core, or the panel bundle breaks.
```

---

## Revisions after the two-agent review (bosun: correctness and trust boundary; purser: plan quality and fit)

Both reviewers confirmed the trust boundary is clean (admin-gated, read-only, returns two integers,
no filesystem paths, no route collision) and the math is correct. Every finding is folded in below.

1. HIGH (both): `test/plugin.test.ts` asserts `cap.minimum === 1`. Add a step to update it to 5.
   To avoid the `multipleOf: 5` edges (an existing stored `8` fails ajv in the fallback form, and the
   `1024` maximum is not itself a multiple of 5), the schema keeps `multipleOf: 1` and only raises
   `minimum` to 5. The test's `multipleOf === 1` assertion stays valid. The 5 GiB increment is enforced
   in the panel (the primary UI), not the fallback schema form.
2. MED (bosun): the panel file is `src/panel/PluginConfigurationPanel.tsx`, not under `components/`.
   Correct every path in Task 5.
3. MED (both): slider step 5 versus a preserved non-multiple value. Resolve by snapping in the panel:
   the number box snaps to the 5 GiB step on commit, and `normalizeConfig` snaps the cap to the nearest
   step after clamping, so the slider and the number box always agree and a legacy `8` shows as `10`.
   Add `snapToStep(value, step)` (round to nearest) to `src/shared/cache-cap.ts`, thread an optional
   `step` through `useNumberDraft`, and pass it from `RangeField`.
4. MED (purser): the over-budget message is a warning, not an error. Add a `warnBanner` style to
   `styles.ts` built from the existing `--cl-warn-bg/fg/border` tokens (mirror `errorBanner`); do not
   reuse the red `errorBanner`.
5. MED (purser): invalid DOM nesting. The free-space line and the warning must not go inside the field
   hint `<p>` (`LabeledField` wraps hint in a `<p>`). Render them as siblings after `<RangeField>` in
   `PluginConfigurationPanel.tsx`, so the static prose stays in the hint and the dynamic line and
   warning are block-level siblings.
6. MED (purser): DRY the statfs-to-freeGiB block. Hoist `src/runtime/free-space.ts` exporting
   `readFreeGiB(dataDir, statfs = statfsSync)`, and call it from both `schema()` and the route (the
   route injects `statfs` for tests). This is a node module, separate from the browser-safe
   `cache-cap.ts`.
7. MED (purser): docs. Add a task to add a CHANGELOG entry (free-space-aware cache cap and 5 GiB
   increments) and refresh the README cache-capacity wording.
8. LOW (bosun): the seed must not arm the beforeunload guard. Add `reseed(config)` to `useConfig` that
   sets both the working state and the saved snapshot to the same object reference, so a seeded
   unconfigured panel is not counted dirty. Save stays enabled through `unconfigured`.
9. LOW (both): the static fallback moves 8 to 10 GiB so the detection-failed default is a multiple of
   the step. Intended. Update the stale comments at `tilecache-container.ts` (the "8 GiB" doc),
   `RangeField.tsx:4` ("1 to 1024 GiB" to "5 to 1024 GiB"), and the `config-types.ts` fallback comment.
10. NIT (purser): broaden the `PANEL_REQUEST_TIMEOUT_MS` comment once the one-shot fetch reuses it.
11. NIT (purser): reshoot the settings screenshot after the panel change, at release time.
