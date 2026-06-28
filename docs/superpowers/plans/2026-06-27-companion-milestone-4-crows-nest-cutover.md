# Milestone 4: crows-nest cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the `signalk-crows-nest` route-draft pipeline through the `signalk-binnacle-companion` container's in-process `routeOnWater` bridge, with the existing in-process router kept as a reversible fallback behind a feature flag.

**Architecture:** The single in-process `routeChannel(deps, req)` call inside crows-nest `handleDraft` becomes a strategy choice. When the companion bridge `globalThis.__signalk_binnacle_routeOnWater` is present, `whenReady()` resolves, and the new `routeDraftUseCompanion` flag is on, crows-nest builds a serializable request (`homeCountryId` in place of the `foreignRings` closure, `deadlineMs` in place of the `AbortSignal`) and calls `bridge.routeOnWater(req)`. The result is the existing `ChannelRouteResult` shape, so `applyChannelRoute` and the whole honesty layer consume it unchanged. A `router-unavailable` outcome or an invalid result falls through to the in-process `routeChannel`. The trust boundary, depth-authority precedence, `checkLegs`, decline vocabulary, budget gate, and admin gate all stay in crows-nest and do not cross the seam.

**Tech Stack:** TypeScript (crows-nest plugin, Node `--test`/tsx or the project's runner), the companion's Rust axum router behind the bridge (unchanged in this milestone), Signal K server-api.

**This milestone reaches the boat.** Milestones 1 to 3 were internal. This is the first change a vessel runs, and it touches the safety honesty layer. Hold the trust boundary: the container computes geometry only and must never make a route read as safer than the data supports.

**Design latitude (per the owner, 2026-06-27):** the companion bridge contract and the crows-nest route-draft seams are NOT frozen. Where a cleaner contract, a shared type, or a small refactor on either side improves the cutover, take it rather than forcing a byte-identical swap. The constraints below are hard; the existing function shapes are not.

## Global Constraints

- One npm package per repo; companion containers are build artifacts, never npm packages. No new HTTP path from crows-nest to the plugin: the only seam is the in-process `globalThis.__signalk_binnacle_routeOnWater` bridge.
- The trust boundary stays in crows-nest: the LLM call, the Signal K reads, the budget and admin gate, depth-authority precedence (`safety-check.ts` provider precedence ENC 0 > EMODnet 10 > OpenSeaMap 20), and all honesty wording. The container returns route geometry plus `usedTileWater` and `borderFallback` only.
- Units are SI internally (meters, radians, Kelvin); convert only at a display edge.
- `homeCountryId` is the ISO 3166-1 alpha-3 SOVEREIGN code (`iso_sov1`, the scheme the companion EEZ boundaries use). crows-nest's `homeForRoute().id` is the Natural Earth admin-0 `iso_a3` UNIT code, which diverges from the sovereign code for dependent and disputed territories (for example `PRI`, `GUM`, `GRL` carry sovereign `USA`, `USA`, `DNK`). The caller MUST map the unit code to the sovereign code before sending `homeCountryId`, or the container blocks the home's own sovereign water as foreign. The two schemes coincide for sovereign mainland states (`USA`, `CAN`), which is why a USA-only test gives false confidence.
- Border-aware behavior change, accepted by decision (2026-06-27): the in-process path blocks foreign water from admin-0 LAND polygons (which cover inland and river boundaries such as the Detroit River); the companion blocks from EEZ MARINE polygons (open-sea maritime boundaries, the companion's resolved-correct source, which do not cover inland rivers). The two sources cover near-disjoint water, so routing border-aware through the companion is a real behavior change on the boat. The decision is to accept EEZ as authoritative, add a cross-source parity check (Task 6), and document the change (Task 7). This is not a silent swap.
- `deadlineMs` is an ABSOLUTE epoch-milliseconds timestamp (crows-nest convention, `channel-router.ts:88`), not a relative duration. The container treats it as a hard internal stop. Pass `deadlineMs` straight through; do not convert to a duration.
- Wire request JSON is camelCase. The engine `ChannelRouteRequest` (`container/engine/src/types.rs`) is `#[serde(rename_all = "camelCase")]`: fields `from`, `to`, `draftMeters`, `safetyMarginMeters`, `standoffNm`, `corridor?`, `bboxAnchors?`, `borderAware`, `maxSnapMeters?`, `deadlineMs?`, `homeCountryId?`. `Position` is `{ latitude, longitude }`. (The design spec section 5 calls the bbox-sizing field `anchors[]`; the engine and this plan call it `bboxAnchors` and treat it as optional. The rename is intentional; the spec wording is the older name.)
- Result union (companion `RouteOnWaterResult`): `{ ok: true, waypoints: Position[], usedTileWater: boolean, borderFallback: boolean } | { ok: false, reason: string }` where `reason` is one of `no-coverage no-path deadline unsnappable land-leg fetch-failed router-unavailable`. The first six map 1:1 to crows-nest `ChannelDeclineReason`; `router-unavailable` is bridge-only and means transport failure.
- No AI-process talk and no em dashes in any commit, changelog, README, code comment, or PR text. Oxford commas. Write "and" not "&". "chartplotter" is one word.
- Verification gate before any "done" claim: in crows-nest `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, all green. Fix every review finding of every severity.

---

## File structure

**signalk-crows-nest (the cutover lives here):**
- Create `src/shared/with-deadline.ts`: hoist the existing module-private `withDeadline<T>(work, ms, onTimeout)` from `endpoint.ts:590` so both `endpoint.ts` and the new `companion-router.ts` reuse one timeout primitive (DRY). Import it in both.
- Create `src/route-draft/channel-router/companion-router.ts`: the bridge client. Reads the global, narrows the bridge and result shapes, builds the serializable request from a `ChannelRouteRequest` plus a sovereign `homeCountryId`, calls `routeOnWater` under a bound, and returns a `ChannelRouteResult` or `null` to signal "fall back to in-process".
- Modify `src/route-draft/endpoint.ts` (around 686 to 716): pick companion vs in-process, build the serializable request, keep the in-process request (closure + signal) for the fallback path; import `withDeadline` from `src/shared/with-deadline.ts`.
- Modify `src/route-draft/country-boundaries.ts` and `scripts/build-boundaries.mjs`: add a sovereign alpha-3 (`SOV_A3`) to the boundary asset and to `Country`, so `homeForRoute()` can return the sovereign code for `homeCountryId` (Task 1).
- Modify `src/route-draft/config.ts`: add `routeDraftUseCompanion` to `RouteDraftConfig`, `normalizeRouteDraftConfig`, and `routeDraftConfigSchema`. This is the SINGLE source: the panel's `normalize-config.ts` already surfaces every route-draft key via `Object.assign(config, normalizeRouteDraftConfig(raw))` (around line 170), so do NOT add a per-field line there.
- Modify `src/shared/types.ts`: add `routeDraftUseCompanion?: boolean` to the `PluginConfig` wire interface (the witness `ROUTE_DRAFT_CONFIG_KEYS_WITNESS` requires every `RouteDraftConfig` key to exist on `PluginConfig`).
- Modify `src/panel/config-reducer.ts` and `src/panel/components/RouteDraftingSection.tsx`: surface the toggle in the admin panel as an inline checkbox (the standalone-boolean pattern used by `noaaEncIncludeWrecks` in `NoaaEncSource.tsx`), NOT the `ToggleFieldset` section shell that `routeDraftEnabled` uses (it requires `children`). Design note from the UI/UX team gates this (Task 3).
- Create `test/route-draft-companion-router.test.ts`: contract tests against a stub bridge.
- Modify `test/route-draft-config.test.ts`: cover the new flag default and normalization.
- Modify `test/route-draft-country-boundaries.test.ts`: lock the sovereign-code mapping (Task 1).
- Modify `CHANGELOG.md`, `README.md` (What's New), and any architecture doc the diff makes stale.

**signalk-binnacle-companion (this repo, contract + handoff only):**
- Modify `docs/superpowers/2026-06-27-m3-handoff.md` and `CLAUDE.md` status lines after the cutover lands.
- The bridge (`src/bridge/route-on-water-bridge.ts`) and its tests already exist and are unchanged unless Task 2 surfaces a contract improvement worth making here.

## Reference: the two seams as they stand today

Companion bridge (`signalk-binnacle-companion/src/bridge/route-on-water-bridge.ts`, `src/shared/types.ts:65`):
```typescript
interface RouteOnWaterBridge {
  whenReady(): Promise<void>
  routeOnWater(request: unknown): Promise<RouteOnWaterResult>
}
type RouteOnWaterResult =
  | { ok: true; waypoints: Position[]; usedTileWater: boolean; borderFallback: boolean }
  | { ok: false; reason: string }
// installed on globalThis['__signalk_binnacle_routeOnWater'] only after the container is up.
// routeOnWater forwards JSON.stringify(request) as-is to POST /route-on-water and returns
// { ok:false, reason:'router-unavailable' } on any transport, non-ok, or JSON error.
```

crows-nest in-process router (`signalk-crows-nest/src/route-draft/channel-router/channel-router.ts:68`):
```typescript
export interface ChannelRouteRequest {
  from: Position; to: Position
  draftMeters: number; safetyMarginMeters: number; standoffNm: number
  corridor?: Position[]
  bboxAnchors?: Position[]
  foreignRings?: (bbox: Bbox) => RingPolygon[] // closure, NOT serializable -> becomes homeCountryId
  maxSnapMeters?: number
  signal?: AbortSignal                          // NOT serializable -> dropped, container honors deadlineMs
  deadlineMs?: number
}
export type ChannelRouteResult =
  | { ok: true, waypoints: Position[], usedTileWater: boolean, borderFallback?: boolean }
  | { ok: false, reason: ChannelDeclineReason }
```

Current call site (`signalk-crows-nest/src/route-draft/endpoint.ts:690`):
```typescript
const channelResult: ChannelRouteResult | { ok: false, reason: 'skipped' } =
  deadlineMs - Date.now() >= ROUTER_MIN_BUDGET_MS
    ? await routeChannel(
        { client: service.enc, queryChartedAreas, queryWater: service.tileWater.queryTileWater, bands: DEPTH_BANDS, logger },
        { from: startPos, to: endPos, draftMeters,
          safetyMarginMeters: config.routeDraftSafetyMarginMeters,
          standoffNm: config.routeDraftStandoffNm,
          ...(parsed.route !== undefined ? { corridor: parsed.route } : { bboxAnchors: route.waypoints.map(toLatLon) }),
          ...(homeCountry !== undefined ? { foreignRings: (bbox) => service.boundaries.foreignRings(homeCountry.id, bbox) } : {}),
          signal: AbortSignal.timeout(Math.max(MS_PER_SECOND, deadlineMs - Date.now())),
          deadlineMs })
    : { ok: false, reason: 'skipped' }
const channel = applyChannelRoute(route.waypoints, channelResult, homeCountry?.name)
```

---

## Task 1: Map the home country to its sovereign alpha-3 for `homeCountryId`

The container's border-aware block keys on `iso_sov1` (the alpha-3 SOVEREIGN code from the Marine Regions EEZ). crows-nest's `homeForRoute().id` is the Natural Earth admin-0 `iso_a3` UNIT code (`country-boundaries.ts:87,100`), read from `assets/boundaries/countries.geojson` (`properties.id`, built by `scripts/build-boundaries.mjs` from `ne_10m_admin_0_countries`). For dependent and disputed territories the unit code differs from the sovereign code (for example `PRI` -> `USA`, `GUM` -> `USA`, `GRL` -> `DNK`), so sending the unit code makes the container treat the home's own sovereign water as foreign. The asset's source carries `SOV_A3`; surface it and send it.

**Files:**
- Modify: `scripts/build-boundaries.mjs` (emit `sovId` from `SOV_A3`), `src/route-draft/country-boundaries.ts` (read `sovId`, add it to `Country`, return it from `homeForRoute`), `assets/boundaries/countries.geojson` (regenerated).
- Test: `test/route-draft-country-boundaries.test.ts`.

**Interfaces:**
- Produces: `Country.sovId: string` (ISO 3166-1 alpha-3 sovereign code), and `homeForRoute(from, to)?.sovId`, consumed by Task 4 as `homeCountryId`. `Country.id` stays the unit code for classify and display.

- [ ] **Step 1: Write the failing mapping test.** Use a fixture with a territory whose sovereign differs, so the test fails on the coinciding-case-only behavior.

```typescript
// test/route-draft-country-boundaries.test.ts  (add)
test('homeForRoute returns the sovereign alpha-3, not the admin-0 unit code', () => {
  // Two points inside Puerto Rico (admin-0 unit PRI, sovereign USA).
  const b = countryBoundariesFrom({ type: 'FeatureCollection', features: [{
    type: 'Feature',
    properties: { id: 'PRI', sovId: 'USA', name: 'Puerto Rico' },
    geometry: { type: 'Polygon', coordinates: [[[-67.3, 17.9], [-65.2, 17.9], [-65.2, 18.5], [-67.3, 18.5], [-67.3, 17.9]]] }
  }] })
  const home = b.homeForRoute({ latitude: 18.2, longitude: -66.5 }, { latitude: 18.3, longitude: -66.0 })
  assert.equal(home?.id, 'PRI')      // unit code unchanged for classify
  assert.equal(home?.sovId, 'USA')   // sovereign code is what crosses to the container
  assert.match(home?.sovId ?? '', /^[A-Z]{3}$/)
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- test/route-draft-country-boundaries.test.ts`. Expected: FAIL (`sovId` is undefined; `Country` has no such field).

- [ ] **Step 3: Add `sovId` through the asset and the loader.**
  - `scripts/build-boundaries.mjs`: when writing each output feature's `properties`, add `sovId: feature.properties.SOV_A3` alongside the existing `id` and `name`. Regenerate the asset (run the script) so `assets/boundaries/countries.geojson` carries `sovId`.
  - `src/route-draft/country-boundaries.ts`: extend `interface Country` with `sovId: string`; extend `RawFeature.properties` and `BoundaryFeature` with `sovId`; at the parse site (line ~100) set `sovId: f.properties?.sovId ?? id` (fall back to the unit code so an old asset still routes for mainland states); return `{ id: f.id, name: f.name, sovId: f.sovId }` from `classify` and thus `homeForRoute`.

- [ ] **Step 4: Run to verify pass.** Run: `npm test -- test/route-draft-country-boundaries.test.ts`. Expected: PASS (both the new test and the existing border-routing fixtures, which use mainland codes where `sovId === id`).

- [ ] **Step 5: Commit.**

```bash
git add scripts/build-boundaries.mjs src/route-draft/country-boundaries.ts assets/boundaries/countries.geojson test/route-draft-country-boundaries.test.ts
git commit -m "feat(route-draft): carry the sovereign alpha-3 for companion border-aware routing"
```

---

## Task 2: Hoist `withDeadline`, then build the companion bridge client

A focused module that owns reading the global, narrowing the untyped bridge and result, building the serializable request, and signaling fallback. Both the readiness probe and the route call are time-bounded, so a wedged container cannot stall the draft. The timeout primitive is the existing `withDeadline`, hoisted to a shared module so this code and `endpoint.ts` share one copy.

**Files:**
- Create: `src/shared/with-deadline.ts`, `src/route-draft/channel-router/companion-router.ts`
- Modify: `src/route-draft/endpoint.ts` (remove the local `withDeadline` at line 590, import the shared one)
- Test: `test/route-draft-companion-router.test.ts`

**Interfaces:**
- Consumes: `ChannelRouteRequest` and `ChannelRouteResult` from `./channel-router.js`; `Position` from the shared types; `withDeadline` from `../../shared/with-deadline.js`.
- Produces:
  - `export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T>` (moved verbatim from `endpoint.ts:590`).
  - `const COMPANION_BRIDGE_KEY = '__signalk_binnacle_routeOnWater'`
  - `interface RouteOnWaterBridge { whenReady(): Promise<void>; routeOnWater(request: unknown): Promise<unknown> }`
  - `function getCompanionBridge(): RouteOnWaterBridge | undefined`
  - `function toCompanionRequest(req: ChannelRouteRequest, homeCountryId: string | undefined): Record<string, unknown>`
  - `async function routeViaCompanion(bridge: RouteOnWaterBridge, req: ChannelRouteRequest, homeCountryId: string | undefined, readyTimeoutMs: number, callTimeoutMs: number): Promise<ChannelRouteResult | null>` (null means "fall back to in-process").

- [ ] **Step 1: Hoist `withDeadline` to a shared module.** Move the function from `endpoint.ts:590` to a new file verbatim, export it, and import it back into `endpoint.ts`. No behavior change.

```typescript
// src/shared/with-deadline.ts
/** Race a promise against a deadline, resolving to `onTimeout()` if the deadline wins. */
export async function withDeadline<T> (work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), Math.max(0, ms))
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}
```

In `endpoint.ts`, delete the local definition and add `import { withDeadline } from '../shared/with-deadline.js'` (adjust the relative path to the file's location). Run `npm run typecheck && npm test` to confirm the existing `withDeadline` callers (the safety-check budget race) still pass.

- [ ] **Step 2: Write the failing companion-client tests.**

```typescript
// test/route-draft-companion-router.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCompanionRequest, routeViaCompanion, getCompanionBridge, COMPANION_BRIDGE_KEY } from '../src/route-draft/channel-router/companion-router.js'

const baseReq = {
  from: { latitude: 37.8, longitude: -122.42 }, to: { latitude: 37.79, longitude: -122.39 },
  draftMeters: 2, safetyMarginMeters: 0.5, standoffNm: 0.02,
  bboxAnchors: [{ latitude: 37.8, longitude: -122.42 }, { latitude: 37.79, longitude: -122.39 }],
  foreignRings: () => [], signal: AbortSignal.timeout(1000), deadlineMs: Date.now() + 5000
}
const twoWaypoints = [{ latitude: 1, longitude: 2 }, { latitude: 1.1, longitude: 2.1 }]

test('toCompanionRequest is camelCase, drops the closure and signal, sets borderAware from homeCountryId', () => {
  const wire = toCompanionRequest(baseReq as any, 'USA')
  assert.equal(wire.draftMeters, 2)
  assert.equal(wire.homeCountryId, 'USA')
  assert.equal(wire.borderAware, true)
  assert.deepEqual(wire.bboxAnchors, baseReq.bboxAnchors)
  assert.ok(!('foreignRings' in wire))
  assert.ok(!('signal' in wire))
})

test('toCompanionRequest with no home country sets borderAware false and omits homeCountryId', () => {
  const wire = toCompanionRequest(baseReq as any, undefined)
  assert.equal(wire.borderAware, false)
  assert.ok(!('homeCountryId' in wire))
})

test('routeViaCompanion passes through a valid ok result', async () => {
  const bridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: true, waypoints: twoWaypoints, usedTileWater: true, borderFallback: false }) }
  const r = await routeViaCompanion(bridge, baseReq as any, 'USA', 2000, 2000)
  assert.deepEqual(r, { ok: true, waypoints: twoWaypoints, usedTileWater: true, borderFallback: false })
})

test('routeViaCompanion passes through a typed decline', async () => {
  const bridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: false, reason: 'no-coverage' }) }
  assert.deepEqual(await routeViaCompanion(bridge, baseReq as any, undefined, 2000, 2000), { ok: false, reason: 'no-coverage' })
})

test('routeViaCompanion returns null (fall back) on router-unavailable', async () => {
  const bridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: false, reason: 'router-unavailable' }) }
  assert.equal(await routeViaCompanion(bridge, baseReq as any, undefined, 2000, 2000), null)
})

test('routeViaCompanion returns null on an unrecognized or malformed result', async () => {
  const bridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: false, reason: 'totally-bogus' }) }
  assert.equal(await routeViaCompanion(bridge, baseReq as any, undefined, 2000, 2000), null)
  const bridge2 = { whenReady: async () => {}, routeOnWater: async () => ({ ok: true, waypoints: 'nope' }) }
  assert.equal(await routeViaCompanion(bridge2, baseReq as any, undefined, 2000, 2000), null)
})

test('routeViaCompanion returns null on a degenerate ok result of fewer than two waypoints', async () => {
  const bridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: true, waypoints: [{ latitude: 1, longitude: 2 }], usedTileWater: false, borderFallback: false }) }
  assert.equal(await routeViaCompanion(bridge, baseReq as any, undefined, 2000, 2000), null)
})

test('routeViaCompanion returns null when whenReady rejects', async () => {
  const bridge = { whenReady: async () => { throw new Error('down') }, routeOnWater: async () => ({ ok: true, waypoints: twoWaypoints, usedTileWater: false, borderFallback: false }) }
  assert.equal(await routeViaCompanion(bridge, baseReq as any, undefined, 2000, 2000), null)
})

test('routeViaCompanion returns null when whenReady never resolves before the ready timeout', async () => {
  const bridge = { whenReady: () => new Promise<void>(() => {}), routeOnWater: async () => ({ ok: true, waypoints: twoWaypoints, usedTileWater: false, borderFallback: false }) }
  assert.equal(await routeViaCompanion(bridge, baseReq as any, undefined, 30, 2000), null)
})

test('routeViaCompanion returns null when routeOnWater hangs past the call timeout', async () => {
  const bridge = { whenReady: async () => {}, routeOnWater: () => new Promise<unknown>(() => {}) }
  assert.equal(await routeViaCompanion(bridge, baseReq as any, undefined, 2000, 30), null)
})

test('getCompanionBridge reads the global key and ignores a non-bridge value', () => {
  const g = globalThis as Record<string, unknown>
  delete g[COMPANION_BRIDGE_KEY]
  assert.equal(getCompanionBridge(), undefined)
  g[COMPANION_BRIDGE_KEY] = { whenReady: async () => {}, routeOnWater: async () => ({}) }
  assert.ok(getCompanionBridge())
  g[COMPANION_BRIDGE_KEY] = { not: 'a bridge' }
  assert.equal(getCompanionBridge(), undefined)
  delete g[COMPANION_BRIDGE_KEY]
})
```

- [ ] **Step 3: Run to verify they fail.** Run: `npm test -- test/route-draft-companion-router.test.ts`. Expected: FAIL with module-not-found for `companion-router.js`.

- [ ] **Step 4: Implement the module.**

```typescript
// src/route-draft/channel-router/companion-router.ts
import type { Position } from '../../shared/types.js'
import type { ChannelRouteRequest, ChannelRouteResult, ChannelDeclineReason } from './channel-router.js'
import { withDeadline } from '../../shared/with-deadline.js'

/** The global key the companion plugin installs its in-process bridge on. */
export const COMPANION_BRIDGE_KEY = '__signalk_binnacle_routeOnWater'

/** The in-process bridge the companion publishes. routeOnWater is untyped on the wire; we narrow its result. */
export interface RouteOnWaterBridge {
  whenReady(): Promise<void>
  routeOnWater(request: unknown): Promise<unknown>
}

/** The six typed decline reasons crows-nest understands; the bridge may also return the transport-only 'router-unavailable'. */
const CHANNEL_REASONS: ReadonlySet<ChannelDeclineReason> = new Set([
  'no-coverage', 'no-path', 'deadline', 'unsnappable', 'land-leg', 'fetch-failed'
])

function isBridge (v: unknown): v is RouteOnWaterBridge {
  return typeof v === 'object' && v !== null
    && typeof (v as RouteOnWaterBridge).whenReady === 'function'
    && typeof (v as RouteOnWaterBridge).routeOnWater === 'function'
}

/** The companion bridge if the plugin has installed it, else undefined. A non-bridge value reads as absent. */
export function getCompanionBridge (): RouteOnWaterBridge | undefined {
  const v = (globalThis as Record<string, unknown>)[COMPANION_BRIDGE_KEY]
  return isBridge(v) ? v : undefined
}

function isPosition (v: unknown): v is Position {
  return typeof v === 'object' && v !== null
    && typeof (v as Position).latitude === 'number' && typeof (v as Position).longitude === 'number'
}

/**
 * Narrow an untyped bridge result to a ChannelRouteResult, or null when it is not one we can trust:
 * a 'router-unavailable' transport decline, an unknown reason, a malformed ok shape, or a degenerate
 * route of fewer than two waypoints (the in-process router never returns one; it declines no-path).
 * Null tells the caller to fall back rather than surface a fabricated, blank, or unverifiable route.
 */
function narrowResult (raw: unknown): ChannelRouteResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.ok === true) {
    if (!Array.isArray(r.waypoints) || r.waypoints.length < 2 || !r.waypoints.every(isPosition)) return null
    if (typeof r.usedTileWater !== 'boolean') return null
    const borderFallback = typeof r.borderFallback === 'boolean' ? r.borderFallback : false
    return { ok: true, waypoints: r.waypoints as Position[], usedTileWater: r.usedTileWater, borderFallback }
  }
  if (r.ok === false && typeof r.reason === 'string' && CHANNEL_REASONS.has(r.reason as ChannelDeclineReason)) {
    return { ok: false, reason: r.reason as ChannelDeclineReason }
  }
  return null // 'router-unavailable', unknown reason, or malformed: fall back.
}

/** Build the serializable wire request: camelCase, no closure, no AbortSignal; the container honors deadlineMs. */
export function toCompanionRequest (req: ChannelRouteRequest, homeCountryId: string | undefined): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    from: req.from, to: req.to,
    draftMeters: req.draftMeters, safetyMarginMeters: req.safetyMarginMeters, standoffNm: req.standoffNm,
    borderAware: homeCountryId !== undefined
  }
  if (req.corridor !== undefined) wire.corridor = req.corridor
  if (req.bboxAnchors !== undefined) wire.bboxAnchors = req.bboxAnchors
  if (req.maxSnapMeters !== undefined) wire.maxSnapMeters = req.maxSnapMeters
  if (req.deadlineMs !== undefined) wire.deadlineMs = req.deadlineMs
  if (homeCountryId !== undefined) wire.homeCountryId = homeCountryId
  return wire
}

/**
 * Route via the companion bridge, or return null to fall back to the in-process router. Both the readiness
 * probe and the route call are time-bounded (with withDeadline), so a wedged container cannot stall the
 * draft: a not-ready bridge, a transport failure, a timeout, or an untrusted result all return null.
 */
export async function routeViaCompanion (
  bridge: RouteOnWaterBridge,
  req: ChannelRouteRequest,
  homeCountryId: string | undefined,
  readyTimeoutMs: number,
  callTimeoutMs: number
): Promise<ChannelRouteResult | null> {
  const ready = await withDeadline(bridge.whenReady().then(() => true).catch(() => false), readyTimeoutMs, () => false)
  if (!ready) return null
  const raw = await withDeadline(
    bridge.routeOnWater(toCompanionRequest(req, homeCountryId)).catch(() => null),
    callTimeoutMs, () => null
  )
  return narrowResult(raw)
}
```

- [ ] **Step 5: Run to verify pass.** Run: `npm test -- test/route-draft-companion-router.test.ts`. Expected: PASS (all cases, including the two timeout cases, which return quickly because the timeout wins).

- [ ] **Step 6: Typecheck and lint.** Run: `npm run typecheck && npm run lint`. Expected: clean.

- [ ] **Step 7: Commit.**

```bash
git add src/shared/with-deadline.ts src/route-draft/endpoint.ts src/route-draft/channel-router/companion-router.ts test/route-draft-companion-router.test.ts
git commit -m "feat(route-draft): add the companion routeOnWater bridge client with bounded calls"
```

---

## Task 3: Add the `routeDraftUseCompanion` config flag end to end

Default on, so the companion is used whenever present (the owner's choice: companion-on when present). The flag exists to force the in-process path.

**Files:**
- Modify: `src/route-draft/config.ts` (interface `RouteDraftConfig`, `normalizeRouteDraftConfig`, `routeDraftConfigSchema`), `src/shared/types.ts` (`PluginConfig`), `src/panel/config-reducer.ts`, `src/panel/components/RouteDraftingSection.tsx`. Do NOT modify `src/panel/normalize-config.ts`: it already surfaces every route-draft key via `Object.assign(config, normalizeRouteDraftConfig(raw))`.
- Test: `test/route-draft-config.test.ts`.

**Interfaces:**
- Produces: `RouteDraftConfig.routeDraftUseCompanion: boolean` (default `true`), consumed by Task 4.

- [ ] **Step 1: Write the failing config test.**

```typescript
// test/route-draft-config.test.ts  (add)
test('routeDraftUseCompanion defaults to true and respects an explicit false', () => {
  assert.equal(normalizeRouteDraftConfig({}).routeDraftUseCompanion, true)
  assert.equal(normalizeRouteDraftConfig({ routeDraftUseCompanion: false }).routeDraftUseCompanion, false)
  assert.equal(normalizeRouteDraftConfig({ routeDraftUseCompanion: true }).routeDraftUseCompanion, true)
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- test/route-draft-config.test.ts`. Expected: FAIL (`routeDraftUseCompanion` is `undefined`).

- [ ] **Step 3: Add the interface field.** In `src/route-draft/config.ts`, after `routeDraftMaxLegNm` in `RouteDraftConfig`:

```typescript
  /** Route through the Binnacle Companion container when its in-process bridge is present. On by default; turn off to force the built-in router. */
  routeDraftUseCompanion: boolean
```

- [ ] **Step 4: Add the wire field.** In `src/shared/types.ts` `PluginConfig`, alongside the other optional `routeDraft*` wire fields:

```typescript
  routeDraftUseCompanion?: boolean
```

(The `ROUTE_DRAFT_CONFIG_KEYS_WITNESS` assertion in `config.ts` will fail to compile if this is missing, which is the guard working.)

- [ ] **Step 5: Add the normalization.** In `normalizeRouteDraftConfig`, mirroring the default-on pattern used elsewhere (`raw[x] !== false`):

```typescript
    routeDraftUseCompanion: c.routeDraftUseCompanion !== false,
```

- [ ] **Step 6: Add the schema entry.** In `routeDraftConfigSchema()`:

```typescript
    routeDraftUseCompanion: {
      type: 'boolean',
      title: 'Use the Binnacle Companion router when available (off forces the built-in router)',
      default: true
    },
```

- [ ] **Step 7: Design the panel toggle with a UI/UX expert team.** STANDING RULE: any panel build or change is designed by a team of UI/UX experts (lead with `signalk-ui-designer` plus a second reviewer), and must stay consistent with the other crows-nest panels: the shared design tokens and theme (light/dark/night-red), the section layout, label voice, and spacing of the existing `RouteDraftingSection` controls. Important: `routeDraftEnabled` uses `ToggleFieldset`, a section-master SHELL whose `children` prop is required, so it does NOT fit a standalone boolean. The correct primitive for a standalone boolean is the inline `<input type='checkbox'>` row used by `noaaEncIncludeWrecks` in `NoaaEncSource.tsx` (the `S.checkboxLabel` pattern). The team confirms: the inline-checkbox primitive, placement inside the route-draft section, the label wording, and the help text, before any panel code is written. Output: a short design note the panel steps below implement verbatim. (The control here is one boolean, so a light two-agent pass suffices; the standing team rule still applies.)

- [ ] **Step 8: Wire the panel per the design note.** Two files, following the UI/UX team's design note from Step 7 (the config normalization is already single-sourced in Task 3 Step 5 via `Object.assign(config, normalizeRouteDraftConfig(raw))` in `normalize-config.ts`, so do NOT touch `normalize-config.ts` here):
  - `src/panel/config-reducer.ts`: add a `setRouteDraftUseCompanion` action and a case `return setField(state, 'routeDraftUseCompanion', action.enabled)` (mirror line 176).
  - `src/panel/components/RouteDraftingSection.tsx`: add an inline checkbox bound to `config.routeDraftUseCompanion`, dispatching `setRouteDraftUseCompanion`, using the `S.checkboxLabel` plus `<input type='checkbox' checked={...} onChange={(e) => dispatch({ type: 'setRouteDraftUseCompanion', enabled: e.target.checked })} />` pattern from `NoaaEncSource.tsx`, with the label and placement the design note specifies. Default-on reads as `config.routeDraftUseCompanion !== false`.

- [ ] **Step 9: Run config test + typecheck.** Run: `npm test -- test/route-draft-config.test.ts && npm run typecheck`. Expected: PASS and clean (the witness compiles).

- [ ] **Step 10: Commit.**

```bash
git add src/route-draft/config.ts src/shared/types.ts src/panel/config-reducer.ts src/panel/components/RouteDraftingSection.tsx test/route-draft-config.test.ts
git commit -m "feat(route-draft): add the routeDraftUseCompanion config flag, default on"
```

---

## Task 4: Wire the strategy into `handleDraft`

Companion first when the flag is on and the bridge is present; in-process `routeChannel` otherwise or on fallback. Keep both request builders: the serializable one for the companion, the closure-and-signal one for in-process. The companion attempt is bounded by the remaining request budget, and the budget is re-gated before the in-process fallback so a slow companion attempt cannot push the built-in router below its minimum budget.

**Files:**
- Modify: `src/route-draft/endpoint.ts` (around 686 to 716).
- Test: `test/route-draft-companion-router.test.ts` (the exported helper is unit-testable without the LLM or HTTP).

**Interfaces:**
- Consumes: `getCompanionBridge`, `routeViaCompanion` (Task 2); `routeChannel` (existing); `config.routeDraftUseCompanion` (Task 3); `homeCountry?.sovId` as the sovereign alpha-3 (Task 1); `ROUTER_MIN_BUDGET_MS` (`endpoint.ts:84`), `MS_PER_SECOND`.
- Produces: `export async function resolveChannelRoute(opts): Promise<ChannelRouteResult | { ok: false, reason: 'skipped' }>`, consumed unchanged by `applyChannelRoute`.

- [ ] **Step 1: Write the failing seam tests.** The helper is pure given an injected `runInProcess`, an injected clock, and a bridge stub. The bridge is gated by the caller, so the helper takes only a `bridge` (already `undefined` when the flag is off).

```typescript
// test/route-draft-companion-router.test.ts  (add; resolveChannelRoute is exported from endpoint.ts)
import { resolveChannelRoute } from '../src/route-draft/endpoint.js'

const okBridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: true, waypoints: twoWaypoints, usedTileWater: false, borderFallback: false }) }
const baseOpts = { req: baseReq as any, homeCountryId: 'USA', readyTimeoutMs: 2000, minBudgetMs: 12_000, deadlineMs: 100_000, now: () => 0 }

test('resolveChannelRoute uses the companion when the bridge returns a result', async () => {
  const r = await resolveChannelRoute({ ...baseOpts, bridge: okBridge, runInProcess: async () => { throw new Error('should not run') } })
  assert.equal(r.ok, true)
})
test('resolveChannelRoute falls back to in-process when the bridge returns null', async () => {
  const bridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: false, reason: 'router-unavailable' }) }
  let ranInProcess = false
  const r = await resolveChannelRoute({ ...baseOpts, bridge, runInProcess: async () => { ranInProcess = true; return { ok: false, reason: 'no-path' } } })
  assert.equal(ranInProcess, true)
  assert.deepEqual(r, { ok: false, reason: 'no-path' })
})
test('resolveChannelRoute uses in-process when the bridge is absent (flag off gives undefined)', async () => {
  let ranInProcess = false
  await resolveChannelRoute({ ...baseOpts, bridge: undefined, runInProcess: async () => { ranInProcess = true; return { ok: false, reason: 'no-coverage' } } })
  assert.equal(ranInProcess, true)
})
test('resolveChannelRoute returns skipped when there is no budget up front', async () => {
  const r = await resolveChannelRoute({ ...baseOpts, deadlineMs: 1000, now: () => 0, bridge: undefined, runInProcess: async () => { throw new Error('no') } })
  assert.deepEqual(r, { ok: false, reason: 'skipped' })
})
test('resolveChannelRoute re-gates: a companion attempt that consumed the budget skips the in-process router', async () => {
  // Clock advances past the budget while the companion attempt runs, then the bridge returns null.
  const clock = [0, 0, 95_000] // up-front gate, callTimeout computation, then the re-gate after the companion attempt
  let i = 0
  const nullBridge = { whenReady: async () => {}, routeOnWater: async () => ({ ok: false, reason: 'router-unavailable' }) }
  const r = await resolveChannelRoute({ ...baseOpts, deadlineMs: 100_000, now: () => clock[Math.min(i++, clock.length - 1)], bridge: nullBridge, runInProcess: async () => { throw new Error('should not run under budget') } })
  assert.deepEqual(r, { ok: false, reason: 'skipped' })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm test -- test/route-draft-companion-router.test.ts`. Expected: FAIL (`resolveChannelRoute` not exported).

- [ ] **Step 3: Add the helper and rewire the call site.** In `endpoint.ts`:

```typescript
// near the other route-draft constants:
/** How long to wait for the companion bridge to report ready before falling back to the in-process router. */
const COMPANION_READY_TIMEOUT_MS = 1500

/**
 * Pick the channel route: the companion bridge when present, else the in-process router. A null from the
 * companion (not ready, a transport failure, a timeout, or an untrusted result) falls back in-process, so
 * the cutover is reversible and a down container degrades to the built-in path rather than failing the draft.
 * The companion attempt is bounded by the remaining budget, and the budget is re-gated before the in-process
 * fallback so a slow companion attempt cannot start the built-in router below ROUTER_MIN_BUDGET_MS.
 */
export async function resolveChannelRoute (opts: {
  bridge: RouteOnWaterBridge | undefined
  runInProcess: () => Promise<ChannelRouteResult>
  req: ChannelRouteRequest
  homeCountryId: string | undefined
  readyTimeoutMs: number
  minBudgetMs: number
  deadlineMs: number
  now?: () => number
}): Promise<ChannelRouteResult | { ok: false, reason: 'skipped' }> {
  const now = opts.now ?? Date.now
  if (opts.deadlineMs - now() < opts.minBudgetMs) return { ok: false, reason: 'skipped' }
  if (opts.bridge !== undefined) {
    const callTimeoutMs = opts.deadlineMs - now()
    const viaCompanion = await routeViaCompanion(opts.bridge, opts.req, opts.homeCountryId, opts.readyTimeoutMs, callTimeoutMs)
    if (viaCompanion !== null) return viaCompanion
  }
  if (opts.deadlineMs - now() < opts.minBudgetMs) return { ok: false, reason: 'skipped' }
  return opts.runInProcess()
}
```

Then replace the `endpoint.ts:690` block. Build the serializable request once and reuse it; the in-process closure builder wraps it with `foreignRings` and `signal`. Pass the SOVEREIGN code (`homeCountry?.sovId`) as `homeCountryId`:

```typescript
const baseChannelReq: ChannelRouteRequest = {
  from: startPos, to: endPos, draftMeters,
  safetyMarginMeters: config.routeDraftSafetyMarginMeters,
  standoffNm: config.routeDraftStandoffNm,
  ...(parsed.route !== undefined ? { corridor: parsed.route } : { bboxAnchors: route.waypoints.map(toLatLon) }),
  deadlineMs
}
const channelResult = await resolveChannelRoute({
  bridge: config.routeDraftUseCompanion ? getCompanionBridge() : undefined,
  homeCountryId: homeCountry?.sovId,
  req: baseChannelReq,
  readyTimeoutMs: COMPANION_READY_TIMEOUT_MS,
  minBudgetMs: ROUTER_MIN_BUDGET_MS,
  deadlineMs,
  runInProcess: () => routeChannel(
    { client: service.enc, queryChartedAreas, queryWater: service.tileWater.queryTileWater, bands: DEPTH_BANDS, logger },
    { ...baseChannelReq,
      ...(homeCountry !== undefined ? { foreignRings: (bbox) => service.boundaries.foreignRings(homeCountry.id, bbox) } : {}),
      signal: AbortSignal.timeout(Math.max(MS_PER_SECOND, deadlineMs - Date.now())) }
  )
})
const channel = applyChannelRoute(route.waypoints, channelResult, homeCountry?.name)
```

The in-process `foreignRings` still keys on `homeCountry.id` (the unit code), which is correct for its admin-0 source; only the companion path uses `sovId`. Import `getCompanionBridge`, `routeViaCompanion`, and `RouteOnWaterBridge` from `./channel-router/companion-router.js`.

- [ ] **Step 4: Run the seam tests.** Run: `npm test -- test/route-draft-companion-router.test.ts`. Expected: PASS.

- [ ] **Step 5: Run the full route-draft suite.** Run: `npm test`. Expected: PASS, including the existing border-routing and channel-path tests (the in-process fallback path is unchanged).

- [ ] **Step 6: Commit.**

```bash
git add src/route-draft/endpoint.ts test/route-draft-companion-router.test.ts
git commit -m "feat(route-draft): route through the companion bridge with in-process fallback"
```

---

## Task 5: Lock the offline depth-not-checked honesty

Spec section 7: when the safety check's depth providers are unreachable (the offline case), an offline draft must never present as depth-checked. `checkLegs` already has a capability-keyed not-checked pass (`safety-check.ts:350-380`) that emits a collapsed "Depth not checked on X of Y legs" note when no depth provider covered the legs (a `checkLeg` that throws leaves `coverage` undefined and the dimension falls to not-checked rather than a silent pass). This task locks that behavior with a regression test, since the companion cutover does not change `checkLegs` and the honesty must not regress. Read `checkLegs` first to confirm, then add the test. If the test reveals a gap, fix it.

**Files:**
- Inspect: `src/route-draft/safety-check.ts` (`checkLegs`, `runOrchestrator`, the not-checked pass at 350-380, the message at line 378).
- Test: `test/route-draft-safety-check.test.ts` (or the existing safety-check suite; match the file the other `checkLegs` tests live in).

**Interfaces:**
- Produces: a regression lock; no new public type.

- [ ] **Step 1: Write the locking test.** Build `checkLegs` deps whose ENC, EMODnet, and OpenSeaMap queries all reject (so every provider's `checkLeg` throws and reports no coverage), run a 2-leg route, and assert the collapsed depth-not-checked note is present.

```typescript
// test/route-draft-safety-check.test.ts  (add; match the existing checkLegs test setup in this file)
test('a check whose depth providers all fail emits the depth-not-checked note for every leg', async () => {
  const reject = async () => { throw new Error('offline') }
  const deps = {
    // reuse this suite's existing helper for the other deps; force the data queries to reject:
    client: { /* EncDirectClient stub whose query rejects */ } as any,
    queryChartedAreas: reject,
    overpass: { query: reject } as any,
    queryTileWater: reject,
    emodnet: { query: reject } as any,
    scanRouteCorridor: (a: any) => a,
    bands: DEPTH_BANDS,
    logger: undefined
  }
  const result = await checkLegs(deps as any, {
    waypoints: [{ latitude: 37.80, longitude: -122.42 }, { latitude: 37.79, longitude: -122.39 }, { latitude: 37.78, longitude: -122.36 }],
    draftMeters: 2, safetyMarginMeters: 0.5, standoffNm: 0.02, corridorHalfWidthMeters: 1852
  })
  assert.equal(result.checked, true)
  assert.ok(result.flags.some((f) => f.message.startsWith('Depth not checked on')), 'every offline leg must carry the depth-not-checked note')
})
```

(If this suite already constructs `checkLegs` deps with a shared factory, reuse it and only override the query functions to reject, rather than rebuilding the whole deps object, to stay DRY.)

- [ ] **Step 2: Run it.** Run: `npm test -- test/route-draft-safety-check.test.ts`. Expected: PASS if the not-checked pass already covers it (the lock holds); FAIL only if a fully-offline check can read as depth-checked.

- [ ] **Step 3: If FAIL, force the caveat.** In `runOrchestrator`'s not-checked pass, ensure the depth dimension falls to the collapsed not-checked note when no depth provider returned coverage on a leg. Re-run Step 2 to green. Do not weaken any existing wording.

- [ ] **Step 4: Commit.**

```bash
git add src/route-draft/safety-check.ts test/route-draft-safety-check.test.ts
git commit -m "test: lock the offline depth-not-checked note on every uncovered leg"
```

---

## Task 6: Cross-source border parity, characterize the accepted divergence

Per the decision, the companion's EEZ marine border source replaces the in-process admin-0 land source. The two cover near-disjoint water, so this task does not assert equality (it would fail by design); it characterizes and locks the divergence direction, so the accepted behavior change is verified rather than assumed.

**Files:**
- Test: `test/route-draft-border-routing.test.ts` (or `test/route-draft-country-boundaries.test.ts`, wherever the `foreignRings` tests live).
- Inspect for the record: companion `docs/superpowers/decisions/2026-06-27-border-aware-boundaries-source.md`, companion live test cell US3WA1EF (Haro Strait).

**Interfaces:**
- Produces: a regression lock that the in-process admin-0 source does not block open-sea boundary water, demonstrating the gap the companion EEZ fills. No new public type.

- [ ] **Step 1: Write the divergence-direction test.** Show that the in-process admin-0 `foreignRings` returns no blocker for an open-sea bbox astride a maritime boundary (so the in-process border block is a no-op offshore, which is exactly why EEZ is accepted as authoritative).

```typescript
// test/route-draft-border-routing.test.ts  (add)
test('the in-process admin-0 source does not block open-sea boundary water (the gap EEZ fills)', () => {
  const boundaries = loadCountryBoundaries() // the bundled admin-0 asset used in-process
  // An offshore bbox in the Pacific west of the US/Canada maritime boundary, over open water
  // that no admin-0 LAND polygon covers (use a small bbox a few nm offshore of Haro Strait's seaward end).
  const offshoreBbox = { minLat: 48.3, minLon: -124.9, maxLat: 48.5, maxLon: -124.7 }
  const rings = boundaries.foreignRings('USA', offshoreBbox as any)
  assert.equal(rings.length, 0, 'admin-0 land covers no open-sea water, so the in-process border block is a no-op offshore')
})
```

- [ ] **Step 2: Run it.** Run: `npm test -- test/route-draft-border-routing.test.ts`. Expected: PASS (admin-0 land returns no offshore ring). If it returns rings, adjust the bbox to genuinely open water and re-run; the point is to lock that the land source is empty over open sea.

- [ ] **Step 3: Record the accepted divergence.** In the Task 7 docs, state plainly: the companion blocks open-sea maritime boundaries via EEZ (verified end to end by the companion's Haro Strait live test, cell US3WA1EF, where `borderFallback` flips between `homeCountryId` USA and CAN), which the in-process land source never did; and the in-process land source blocks inland and river boundaries (the Detroit River) that EEZ marine polygons may not cover. The full end-to-end cross-source comparison on a real region store is a boat test (added to the boat-only list).

- [ ] **Step 4: Commit.**

```bash
git add test/route-draft-border-routing.test.ts
git commit -m "test: characterize the EEZ versus admin-0 border-source divergence"
```

## Task 7: Docs, changelog, and the deprecation note

**Files:**
- Modify: `CHANGELOG.md`, `README.md` (What's New) in crows-nest; `docs/superpowers/2026-06-27-m3-handoff.md` and `CLAUDE.md` status in the companion repo.

- [ ] **Step 1: crows-nest CHANGELOG.** Add a dated entry: route drafting can route through the Binnacle Companion container when installed, with the built-in router as an automatic fallback, controlled by a new "Use Binnacle Companion router when available" setting (on by default). State the border-aware behavior change plainly: when routing through the companion, border-aware routing uses the EEZ maritime boundary source, which blocks open-sea boundaries the built-in admin-0 source did not, and does not cover the inland and river boundaries the built-in source did. No AI-process talk, no em dashes, Oxford commas.

- [ ] **Step 2: crows-nest README What's New.** Overwrite to the single most-recent release describing the companion routing option and the fallback.

- [ ] **Step 3: Deprecation horizon note.** In the crows-nest route-draft code or a short doc, note that the in-process router is retained as the fallback and standalone path, with removal deferred until the companion has shipped and proven out. Do not delete the in-process path in this milestone.

- [ ] **Step 4: Companion handoff update.** In `signalk-binnacle-companion/docs/superpowers/2026-06-27-m3-handoff.md`, mark Milestone 4 status and record the boat-only tests that remain (the bridge reach and fallback on a live server). Update the `CLAUDE.md` status line.

- [ ] **Step 5: Commit (per repo).**

```bash
# in signalk-crows-nest
git add CHANGELOG.md README.md
git commit -m "docs: note companion routing and the built-in fallback"
# in signalk-binnacle-companion
git add docs/superpowers/2026-06-27-m3-handoff.md CLAUDE.md
git commit -m "docs: mark milestone 4 crows-nest cutover status"
```

---

## Final verification gate

- [ ] In `signalk-crows-nest`: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, all green.
- [ ] Run `/simplify` on the crows-nest diff and apply every finding of every severity (reuse, naming, hot-path, altitude). Re-run the gate.
- [ ] Confirm the conventional-commit types match the diff scope (`feat` for the cutover, `docs` for docs, `test` for the lock tests).
- [ ] Confirm no behavior change on the in-process path when `routeDraftUseCompanion` is off or the bridge is absent: the existing border-routing and channel-path tests still pass unchanged.

## Boat-only tests (cannot run without a live signalk-server plus the companion)

1. With the companion plugin installed and its container up, a route draft in crows-nest produces a water-following route via the bridge (`usedTileWater` and `borderFallback` drive the existing caveats).
2. With the companion absent or its container down, the same draft falls back to the in-process router and still returns a route, with no error surfaced to the user.
3. With `routeDraftUseCompanion` turned off, drafting uses the in-process router even when the companion is present.
4. A border-aware draft (same-country endpoints near an international boundary) blocks foreign water through the companion via the EEZ maritime source (`homeCountryId` as the sovereign alpha-3). This is a behavior change from the in-process admin-0 land source (`foreignRings`), not an identical result: confirm the companion blocks the open-sea boundary case end to end (the Haro Strait scenario) on a real EEZ store, and confirm a territory home (for example a Puerto Rico endpoint) sends sovereign `USA`, not unit `PRI`.

## Self-review notes

- Spec section 5 contract: covered by the global constraints (camelCase wire, the result union, `deadlineMs` as absolute epoch ms) and Tasks 2 and 4.
- Spec section 7 integration: the `routeChannel` to bridge swap (Task 4), the sovereign `homeCountryId` instead of the closure (Tasks 1, 2, 4), `deadlineMs` instead of the signal (Task 2), the feature flag and fallback (Tasks 3, 4), the offline depth-not-checked honesty lock (Task 5), and the border-source divergence characterization (Task 6).
- Spec section 5 `GET /regions`: not consumed by crows-nest in this milestone, by design. The `no-coverage` decline plus the in-process fallback already cover "a passage left covered water"; a proactive coverage warning is deferred to a later milestone.
- Trust boundary: `checkLegs`, depth precedence, decline notes, budget, and admin gate are untouched; only the geometry source moves. The one trust-affecting change, border-aware switching from admin-0 land to EEZ marine, is an accepted, documented, and tested behavior change (Tasks 6, 7), not a silent swap.
- Type consistency: `ChannelRouteResult`, `ChannelRouteRequest`, `ChannelDeclineReason`, `Position`, `RouteOnWaterBridge`, `getCompanionBridge`, `routeViaCompanion`, `toCompanionRequest`, `resolveChannelRoute`, `withDeadline`, `Country.sovId`, and `routeDraftUseCompanion` are used with the same names and shapes across Tasks 1 through 4.
- Resolved review risks: the country-code scheme (admin-0 unit versus sovereign) is fixed by Task 1 and locked with a divergent-case test, not a USA-only test; the `withDeadline` reuse and the `routeOnWater` time bound (Task 2) replace the earlier broken inline timeout; `narrowResult` rejects a degenerate sub-two-waypoint route; the panel uses the inline-checkbox primitive, not the `ToggleFieldset` shell; and `normalize-config.ts` is left alone because the route-draft keys flow through `Object.assign(config, normalizeRouteDraftConfig(raw))` already.
