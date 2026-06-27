# signalk-binnacle-companion Milestone 1: plugin and container plumbing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Signal K companion plugin and a trivial Rust container, wired together through `signalk-container`, so the end-to-end plumbing (plugin lifecycle, container launch, address resolution, health, and the in-process route-on-water bridge) works on the Pi before any routing code exists.

**Architecture:** A thin Node Signal K plugin owns the trust boundary and lifecycle. On start it resolves the `signalk-container` manager from `globalThis.__signalk_containerManager`, waits for the runtime, launches a managed Rust container via `ensureRunning` with `signalkAccessiblePorts`, resolves the container address, and installs an in-process bridge on `globalThis.__signalk_binnacle_routeOnWater` for crows-nest to call later. The Rust container is a minimal axum service exposing `/health` and `/regions`, shipped as a near-static binary in a distroless image. This milestone is internal: nothing reaches the boat until the cutover in a later milestone.

**Tech Stack:** TypeScript (ESM, NodeNext) Signal K plugin built with `tsc`, tested with `node --test` via `tsx`, linted with `neostandard`/eslint. Rust (axum, tokio) container built multi-stage on `rust:1-bookworm` into `gcr.io/distroless/cc-debian12`. Lifecycle delegated to the installed `signalk-container` plugin.

## Global Constraints

- Node engines: `>=20.3.0`.
- Module system: ESM with NodeNext resolution; import specifiers use the `.js` extension; the plugin entrypoint uses the `export =` factory form.
- Tests: `node --import tsx --test test/*.test.ts`, using `node:test` and `node:assert/strict`.
- No `prepare` or `prepack` lifecycle script in `package.json` (it corrupts the App Store install-simulation CI step). If git hooks are wanted, wire them through a non-lifecycle script run manually.
- Dependency on `signalk-container` is declared two ways: `peerDependencies` `"signalk-container": ">=1.20.0"` and `signalk.requires: ["signalk-container"]`. Neither gates runtime; the real guard is resolving `globalThis.__signalk_containerManager`, awaiting `whenReady()`, and checking `getRuntime()`.
- The crows-nest caller integration is in-process via `globalThis.__signalk_binnacle_routeOnWater`, never an HTTP call from crows-nest to the plugin.
- The container is tokenless and reached only through `resolveContainerAddress` after `ensureRunning` with `signalkAccessiblePorts`. Never pass a manual `ports` or `networkMode` alongside `signalkAccessiblePorts`.
- Runtime image carries no GDAL, no SpatiaLite, no libgeos, and no libproj. The container healthcheck calls the binary's own `healthcheck` subcommand in exec form (distroless has no shell and no curl).
- App Store metadata (`appIcon`, `signalk.screenshots`) is added at the later deploy and compliance milestone, not here, so no broken asset paths ship.
- Any user-facing text (config titles, descriptions, status strings, commit messages, docs) uses no em dashes, uses Oxford commas, and writes the word "and" rather than an ampersand.

---

### Task 1: Package scaffold, toolchain, and plugin identity

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `eslint.config.js`
- Create: `src/shared/plugin-id.ts`
- Test: `test/plugin-id.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PLUGIN_ID: string` (value `'signalk-binnacle-companion'`), `PLUGIN_NAME: string` (value `'Binnacle Companion'`), `PLUGIN_DESCRIPTION: string`, `PLUGIN_REPO_URL: string`, all exported from `src/shared/plugin-id.js`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "signalk-binnacle-companion",
  "version": "0.0.1",
  "description": "Signal K companion that runs a polyglot container alongside the server, hosting compute and datasets that a JS/TS plugin cannot.",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist",
    "CHANGELOG.md"
  ],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "test": "node --import tsx --test test/*.test.ts",
    "prepublishOnly": "npm run build"
  },
  "keywords": [
    "signalk-node-server-plugin",
    "signalk-category-utility",
    "container",
    "companion"
  ],
  "signalk-plugin-enabled-by-default": false,
  "signalk": {
    "displayName": "Binnacle Companion",
    "requires": ["signalk-container"],
    "recommends": ["signalk-crows-nest", "signalk-binnacle", "signalk-container"]
  },
  "peerDependencies": {
    "signalk-container": ">=1.20.0"
  },
  "engines": {
    "node": ">=20.3.0"
  },
  "author": {
    "name": "Nearl Crews",
    "email": "NearlCrews@users.noreply.github.com"
  },
  "license": "MIT",
  "homepage": "https://github.com/NearlCrews/signalk-binnacle-companion#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/NearlCrews/signalk-binnacle-companion.git"
  },
  "bugs": {
    "url": "https://github.com/NearlCrews/signalk-binnacle-companion/issues"
  },
  "devDependencies": {
    "@signalk/server-api": "^2.28.0",
    "@types/node": "^25.9.4",
    "eslint": "^9.39.4",
    "neostandard": "^0.13.0",
    "tsx": "^4.22.3",
    "typescript": "^6.0.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `tsconfig.test.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Create `eslint.config.js`**

```javascript
import neostandard from 'neostandard'

export default neostandard({
  ts: true,
  ignores: ['dist/', 'node_modules/', 'container/']
})
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: dependencies install with no error, a `package-lock.json` is written.

- [ ] **Step 6: Write the failing test**

Create `test/plugin-id.test.ts`:

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_REPO_URL } from '../src/shared/plugin-id.js'

test('plugin id matches the npm package name', () => {
  assert.equal(PLUGIN_ID, 'signalk-binnacle-companion')
})

test('plugin name and description are human readable and non-empty', () => {
  assert.equal(PLUGIN_NAME, 'Binnacle Companion')
  assert.ok(PLUGIN_DESCRIPTION.length > 0)
})

test('the repo url points at the github project', () => {
  assert.match(PLUGIN_REPO_URL, /github\.com\/NearlCrews\/signalk-binnacle-companion/)
})
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, the module `../src/shared/plugin-id.js` cannot be resolved.

- [ ] **Step 8: Create `src/shared/plugin-id.ts`**

```typescript
/** Stable identity constants for the plugin, imported wherever the id or name is needed. */

export const PLUGIN_ID = 'signalk-binnacle-companion'
export const PLUGIN_NAME = 'Binnacle Companion'
export const PLUGIN_DESCRIPTION =
  'Runs a polyglot container alongside Signal K, hosting compute and datasets that a JS or TS plugin cannot.'
export const PLUGIN_REPO_URL = 'https://github.com/NearlCrews/signalk-binnacle-companion'
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, three tests pass.

- [ ] **Step 10: Verify typecheck and lint are green**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0 with no error.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json eslint.config.js src/shared/plugin-id.ts test/plugin-id.test.ts
git commit -m "feat: scaffold companion plugin package and identity constants"
```

---

### Task 2: Shared types

**Files:**
- Create: `src/shared/types.ts`
- Test: `test/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/shared/types.js`:
  - `Position` = `{ latitude: number; longitude: number }`.
  - `ContainerRuntimeInfo` = `{ runtime: string; version?: string }`.
  - `ContainerHealthcheck` = `{ test: string[]; interval?: string; timeout?: string; startPeriod?: string; retries?: number }`.
  - `ContainerResourceLimits` = `{ memory?: string; memorySwap?: string; cpus?: number; pidsLimit?: number; oomScoreAdj?: number }`.
  - `ContainerConfig` = `{ image: string; tag?: string; signalkAccessiblePorts?: number[]; healthcheck?: ContainerHealthcheck; resources?: ContainerResourceLimits; restart?: string; env?: Record<string, string> }`.
  - `ContainerManager` = `{ whenReady(): Promise<void>; getRuntime(): ContainerRuntimeInfo | null; ensureRunning(name: string, config: ContainerConfig): Promise<void>; resolveContainerAddress(name: string, port: number): Promise<string | null>; stop(name: string): Promise<void> }`.
  - `RouteOnWaterResult` = `{ ok: true; waypoints: Position[]; usedTileWater: boolean; borderFallback: boolean } | { ok: false; reason: string }`. (The `reason` string narrows to the typed channel-decline union in the cutover milestone.)
  - `RouteOnWaterBridge` = `{ whenReady(): Promise<void>; routeOnWater(request: unknown): Promise<RouteOnWaterResult> }`.

- [ ] **Step 1: Write the failing test**

Create `test/types.test.ts`:

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import type { RouteOnWaterResult } from '../src/shared/types.js'

// A compile-time and runtime check that the discriminated union narrows on `ok`.
test('a successful result carries waypoints and flags', () => {
  const result: RouteOnWaterResult = {
    ok: true,
    waypoints: [{ latitude: 1, longitude: 2 }],
    usedTileWater: false,
    borderFallback: false
  }
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.waypoints.length, 1)
    assert.equal(result.usedTileWater, false)
  }
})

test('a failed result carries a reason', () => {
  const result: RouteOnWaterResult = { ok: false, reason: 'router-unavailable' }
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'router-unavailable')
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, the module `../src/shared/types.js` cannot be resolved.

- [ ] **Step 3: Create `src/shared/types.ts`**

```typescript
/** Cross-module types: the container manager surface this plugin consumes, and the route-on-water bridge contract. */

export interface Position {
  latitude: number
  longitude: number
}

export interface ContainerRuntimeInfo {
  runtime: string
  version?: string
}

export interface ContainerHealthcheck {
  test: string[]
  interval?: string
  timeout?: string
  startPeriod?: string
  retries?: number
}

export interface ContainerResourceLimits {
  memory?: string
  memorySwap?: string
  cpus?: number
  pidsLimit?: number
  oomScoreAdj?: number
}

export interface ContainerConfig {
  image: string
  tag?: string
  signalkAccessiblePorts?: number[]
  healthcheck?: ContainerHealthcheck
  resources?: ContainerResourceLimits
  restart?: string
  env?: Record<string, string>
}

/** The subset of the signalk-container manager API this plugin uses. */
export interface ContainerManager {
  whenReady(): Promise<void>
  getRuntime(): ContainerRuntimeInfo | null
  ensureRunning(name: string, config: ContainerConfig): Promise<void>
  resolveContainerAddress(name: string, port: number): Promise<string | null>
  stop(name: string): Promise<void>
}

export type RouteOnWaterResult =
  | { ok: true; waypoints: Position[]; usedTileWater: boolean; borderFallback: boolean }
  | { ok: false; reason: string }

/** Installed on globalThis for in-process callers (crows-nest) to reach the router. */
export interface RouteOnWaterBridge {
  whenReady(): Promise<void>
  routeOnWater(request: unknown): Promise<RouteOnWaterResult>
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts test/types.test.ts
git commit -m "feat: add shared container-manager and route-on-water types"
```

---

### Task 3: Container manager resolution and runtime guard

**Files:**
- Create: `src/runtime/container-manager.ts`
- Test: `test/container-manager.test.ts`

**Interfaces:**
- Consumes: `ContainerManager` from `src/shared/types.js`; `ServerAPI` from `@signalk/server-api`.
- Produces, exported from `src/runtime/container-manager.js`:
  - `getContainerManager(): ContainerManager | null` (reads `globalThis.__signalk_containerManager`, no side effects).
  - `requireContainerManager(app: ServerAPI): ContainerManager | null` (returns the manager, or calls `app.setPluginError` and returns `null`).
  - `ensureRuntimeReady(app: ServerAPI, manager: ContainerManager): Promise<boolean>` (awaits `whenReady`, returns `false` and calls `setPluginError` when `getRuntime()` is null).

- [ ] **Step 1: Write the failing test**

Create `test/container-manager.test.ts`:

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerManager } from '../src/shared/types.js'
import {
  getContainerManager,
  requireContainerManager,
  ensureRuntimeReady
} from '../src/runtime/container-manager.js'

interface FakeApp {
  errors: string[]
  setPluginError(message: string): void
}

function fakeApp (): FakeApp {
  return { errors: [], setPluginError (m: string) { this.errors.push(m) } }
}

function fakeManager (runtimePresent: boolean): ContainerManager {
  return {
    async whenReady () {},
    getRuntime () { return runtimePresent ? { runtime: 'docker' } : null },
    async ensureRunning () {},
    async resolveContainerAddress () { return '127.0.0.1:8080' },
    async stop () {}
  }
}

test.afterEach(() => {
  delete (globalThis as Record<string, unknown>).__signalk_containerManager
})

test('getContainerManager returns null when the global is absent', () => {
  assert.equal(getContainerManager(), null)
})

test('requireContainerManager sets a plugin error when the manager is missing', () => {
  const app = fakeApp()
  const result = requireContainerManager(app as never)
  assert.equal(result, null)
  assert.equal(app.errors.length, 1)
})

test('requireContainerManager returns the manager when present', () => {
  const manager = fakeManager(true)
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = manager
  const app = fakeApp()
  assert.equal(requireContainerManager(app as never), manager)
  assert.equal(app.errors.length, 0)
})

test('ensureRuntimeReady is false and reports when no runtime is detected', async () => {
  const app = fakeApp()
  const ready = await ensureRuntimeReady(app as never, fakeManager(false))
  assert.equal(ready, false)
  assert.equal(app.errors.length, 1)
})

test('ensureRuntimeReady is true when a runtime is detected', async () => {
  const app = fakeApp()
  const ready = await ensureRuntimeReady(app as never, fakeManager(true))
  assert.equal(ready, true)
  assert.equal(app.errors.length, 0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, the module `../src/runtime/container-manager.js` cannot be resolved.

- [ ] **Step 3: Create `src/runtime/container-manager.ts`**

```typescript
/** Resolves the signalk-container manager from the global it publishes, and guards on a detected runtime. */

import type { ServerAPI } from '@signalk/server-api'
import type { ContainerManager } from '../shared/types.js'

export function getContainerManager (): ContainerManager | null {
  const manager = (globalThis as { __signalk_containerManager?: ContainerManager }).__signalk_containerManager
  return manager ?? null
}

export function requireContainerManager (app: ServerAPI): ContainerManager | null {
  const manager = getContainerManager()
  if (!manager) {
    app.setPluginError('The signalk-container plugin is required but was not found. Install and enable it.')
    return null
  }
  return manager
}

export async function ensureRuntimeReady (app: ServerAPI, manager: ContainerManager): Promise<boolean> {
  await manager.whenReady()
  if (!manager.getRuntime()) {
    app.setPluginError('No container runtime was detected. Install Docker or Podman and configure signalk-container.')
    return false
  }
  return true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, five tests pass.

- [ ] **Step 5: Verify typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/container-manager.ts test/container-manager.test.ts
git commit -m "feat: resolve signalk-container manager and guard on runtime"
```

---

### Task 4: Router container launch, address resolution, and health probe

**Files:**
- Create: `src/runtime/router-container.ts`
- Test: `test/router-container.test.ts`

**Interfaces:**
- Consumes: `ContainerManager`, `ContainerConfig` from `src/shared/types.js`.
- Produces, exported from `src/runtime/router-container.js`:
  - `ROUTER_CONTAINER_NAME: string` (value `'binnacle-router'`), `ROUTER_INTERNAL_PORT: number` (value `8080`), `DEFAULT_ROUTER_IMAGE: string`, `DEFAULT_ROUTER_TAG: string`.
  - `buildRouterConfig(opts?: { image?: string; tag?: string }): ContainerConfig`.
  - `startRouterContainer(manager: ContainerManager, opts?: { image?: string; tag?: string }): Promise<string>` (returns the resolved `host:port` address).
  - `probeRouterHealth(address: string, fetchFn?: FetchLike): Promise<boolean>` where `FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>`.

- [ ] **Step 1: Write the failing test**

Create `test/router-container.test.ts`:

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerConfig, ContainerManager } from '../src/shared/types.js'
import {
  ROUTER_CONTAINER_NAME,
  ROUTER_INTERNAL_PORT,
  buildRouterConfig,
  startRouterContainer,
  probeRouterHealth
} from '../src/runtime/router-container.js'

test('the container config requests the accessible port and never a manual ports field', () => {
  const config = buildRouterConfig()
  assert.deepEqual(config.signalkAccessiblePorts, [ROUTER_INTERNAL_PORT])
  assert.equal('ports' in config, false)
  assert.equal('networkMode' in config, false)
  assert.equal(config.resources?.memory, config.resources?.memorySwap)
})

test('startRouterContainer ensures the container and returns the resolved address', async () => {
  const calls: Array<{ name: string; config: ContainerConfig }> = []
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (name, config) { calls.push({ name, config }) },
    async resolveContainerAddress (name, port) {
      assert.equal(name, ROUTER_CONTAINER_NAME)
      assert.equal(port, ROUTER_INTERNAL_PORT)
      return '127.0.0.1:8080'
    },
    async stop () {}
  }
  const address = await startRouterContainer(manager, { tag: 'v1' })
  assert.equal(address, '127.0.0.1:8080')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, ROUTER_CONTAINER_NAME)
  assert.equal(calls[0].config.tag, 'v1')
})

test('startRouterContainer throws when no address is resolvable', async () => {
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning () {},
    async resolveContainerAddress () { return null },
    async stop () {}
  }
  await assert.rejects(() => startRouterContainer(manager), /address/)
})

test('probeRouterHealth is true only for a 200 with status ok', async () => {
  const ok = await probeRouterHealth('127.0.0.1:8080', async () => ({ ok: true, async json () { return { status: 'ok' } } }))
  assert.equal(ok, true)
  const badStatus = await probeRouterHealth('127.0.0.1:8080', async () => ({ ok: true, async json () { return { status: 'down' } } }))
  assert.equal(badStatus, false)
  const notOk = await probeRouterHealth('127.0.0.1:8080', async () => ({ ok: false, async json () { return {} } }))
  assert.equal(notOk, false)
})

test('probeRouterHealth is false when the fetch throws', async () => {
  const result = await probeRouterHealth('127.0.0.1:8080', async () => { throw new Error('connection refused') })
  assert.equal(result, false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, the module `../src/runtime/router-container.js` cannot be resolved.

- [ ] **Step 3: Create `src/runtime/router-container.ts`**

```typescript
/** Builds the managed router container config, launches it via the manager, and probes its health endpoint. */

import type { ContainerConfig, ContainerManager } from '../shared/types.js'

export const ROUTER_CONTAINER_NAME = 'binnacle-router'
export const ROUTER_INTERNAL_PORT = 8080
export const DEFAULT_ROUTER_IMAGE = 'ghcr.io/nearlcrews/signalk-binnacle-router'
export const DEFAULT_ROUTER_TAG = 'latest'

/** Exec-form probe: distroless has no shell, so the binary checks its own liveness. */
const ROUTER_HEALTHCHECK = {
  test: ['CMD', '/router', 'healthcheck'],
  interval: '30s',
  timeout: '5s',
  startPeriod: '15s',
  retries: 3
}

/** Equal memory and memorySwap disables swap; a positive oomScoreAdj makes the router die before Signal K. */
const ROUTER_RESOURCES = {
  memory: '1g',
  memorySwap: '1g',
  cpus: 2,
  pidsLimit: 256,
  oomScoreAdj: 800
}

export interface RouterContainerOptions {
  image?: string
  tag?: string
}

export function buildRouterConfig (opts: RouterContainerOptions = {}): ContainerConfig {
  return {
    image: opts.image ?? DEFAULT_ROUTER_IMAGE,
    tag: opts.tag ?? DEFAULT_ROUTER_TAG,
    signalkAccessiblePorts: [ROUTER_INTERNAL_PORT],
    healthcheck: ROUTER_HEALTHCHECK,
    resources: ROUTER_RESOURCES,
    restart: 'unless-stopped'
  }
}

export async function startRouterContainer (
  manager: ContainerManager,
  opts: RouterContainerOptions = {}
): Promise<string> {
  await manager.ensureRunning(ROUTER_CONTAINER_NAME, buildRouterConfig(opts))
  const address = await manager.resolveContainerAddress(ROUTER_CONTAINER_NAME, ROUTER_INTERNAL_PORT)
  if (!address) {
    throw new Error('The router container address could not be resolved after ensureRunning.')
  }
  return address
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>

export async function probeRouterHealth (address: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  try {
    const response = await fetchFn(`http://${address}/health`)
    if (!response.ok) return false
    const body = (await response.json()) as { status?: string }
    return body.status === 'ok'
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/router-container.ts test/router-container.test.ts
git commit -m "feat: launch router container and probe its health endpoint"
```

---

### Task 5: The in-process route-on-water bridge

**Files:**
- Create: `src/bridge/route-on-water-bridge.ts`
- Test: `test/route-on-water-bridge.test.ts`

**Interfaces:**
- Consumes: `RouteOnWaterBridge`, `RouteOnWaterResult` from `src/shared/types.js`.
- Produces, exported from `src/bridge/route-on-water-bridge.js`:
  - `BRIDGE_GLOBAL_KEY: string` (value `'__signalk_binnacle_routeOnWater'`).
  - `installRouteOnWaterBridge(bridge: RouteOnWaterBridge): void`.
  - `removeRouteOnWaterBridge(): void`.
  - `getRouteOnWaterBridge(): RouteOnWaterBridge | undefined`.
  - `createSkeletonBridge(address: string, probe: (address: string) => Promise<boolean>): RouteOnWaterBridge` (this milestone's stub: `routeOnWater` returns `{ ok: false, reason: 'not-implemented' }` when the container is healthy, `{ ok: false, reason: 'router-unavailable' }` when it is not; the real routing arrives in the cutover milestone).

- [ ] **Step 1: Write the failing test**

Create `test/route-on-water-bridge.test.ts`:

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_GLOBAL_KEY,
  installRouteOnWaterBridge,
  removeRouteOnWaterBridge,
  getRouteOnWaterBridge,
  createSkeletonBridge
} from '../src/bridge/route-on-water-bridge.js'

test.afterEach(() => {
  removeRouteOnWaterBridge()
})

test('install publishes the bridge on the global key and remove clears it', () => {
  const bridge = createSkeletonBridge('127.0.0.1:8080', async () => true)
  installRouteOnWaterBridge(bridge)
  assert.equal((globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY], bridge)
  assert.equal(getRouteOnWaterBridge(), bridge)
  removeRouteOnWaterBridge()
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('remove is safe to call when nothing is installed', () => {
  removeRouteOnWaterBridge()
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('the skeleton bridge reports not-implemented when the container is healthy', async () => {
  const bridge = createSkeletonBridge('127.0.0.1:8080', async () => true)
  const result = await bridge.routeOnWater({})
  assert.deepEqual(result, { ok: false, reason: 'not-implemented' })
})

test('the skeleton bridge reports router-unavailable when the container is unhealthy', async () => {
  const bridge = createSkeletonBridge('127.0.0.1:8080', async () => false)
  const result = await bridge.routeOnWater({})
  assert.deepEqual(result, { ok: false, reason: 'router-unavailable' })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, the module `../src/bridge/route-on-water-bridge.js` cannot be resolved.

- [ ] **Step 3: Create `src/bridge/route-on-water-bridge.ts`**

```typescript
/** Publishes the route-on-water bridge on globalThis so in-process callers (crows-nest) reach the router without HTTP. */

import type { RouteOnWaterBridge } from '../shared/types.js'

export const BRIDGE_GLOBAL_KEY = '__signalk_binnacle_routeOnWater'

export function installRouteOnWaterBridge (bridge: RouteOnWaterBridge): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY] = bridge
}

export function removeRouteOnWaterBridge (): void {
  delete (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY]
}

export function getRouteOnWaterBridge (): RouteOnWaterBridge | undefined {
  return (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY] as RouteOnWaterBridge | undefined
}

/**
 * Milestone 1 stub. Readiness resolves immediately; routeOnWater reports that real
 * routing is not implemented yet, distinguishing a healthy container from an
 * unreachable one. The cutover milestone replaces this with the real implementation
 * that posts the request to the container and returns its ChannelRouteResult.
 */
export function createSkeletonBridge (
  address: string,
  probe: (address: string) => Promise<boolean>
): RouteOnWaterBridge {
  return {
    async whenReady () {},
    async routeOnWater () {
      const healthy = await probe(address)
      return { ok: false, reason: healthy ? 'not-implemented' : 'router-unavailable' }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/bridge/route-on-water-bridge.ts test/route-on-water-bridge.test.ts
git commit -m "feat: add in-process route-on-water bridge with a skeleton implementation"
```

---

### Task 6: The plugin factory and entrypoint

**Files:**
- Create: `src/plugin/plugin.ts`
- Create: `src/index.ts`
- Test: `test/plugin.test.ts`

**Interfaces:**
- Consumes: `PLUGIN_ID`, `PLUGIN_NAME`, `PLUGIN_DESCRIPTION` from `src/shared/plugin-id.js`; `requireContainerManager`, `getContainerManager`, `ensureRuntimeReady` from `src/runtime/container-manager.js`; `ROUTER_CONTAINER_NAME`, `startRouterContainer`, `probeRouterHealth` from `src/runtime/router-container.js`; `installRouteOnWaterBridge`, `removeRouteOnWaterBridge`, `createSkeletonBridge`, `getRouteOnWaterBridge` from `src/bridge/route-on-water-bridge.js`; `Plugin`, `ServerAPI` from `@signalk/server-api`.
- Produces: `createPlugin(app: ServerAPI): Plugin` from `src/plugin/plugin.js`; the default `export =` factory from `src/index.js`.

- [ ] **Step 1: Write the failing test**

Create `test/plugin.test.ts`:

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerConfig, ContainerManager } from '../src/shared/types.js'
import { createPlugin } from '../src/plugin/plugin.js'
import { getRouteOnWaterBridge } from '../src/bridge/route-on-water-bridge.js'
import { ROUTER_CONTAINER_NAME } from '../src/runtime/router-container.js'

interface Recorder {
  status: string[]
  errors: string[]
  setPluginStatus (m: string): void
  setPluginError (m: string): void
  debug (...args: unknown[]): void
}

function fakeApp (): Recorder {
  return {
    status: [],
    errors: [],
    setPluginStatus (m) { this.status.push(m) },
    setPluginError (m) { this.errors.push(m) },
    debug () {}
  }
}

function fakeManager (record: { ensured: Array<{ name: string; config: ContainerConfig }>; stopped: string[] }): ContainerManager {
  return {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (name, config) { record.ensured.push({ name, config }) },
    async resolveContainerAddress () { return '127.0.0.1:8080' },
    async stop (name) { record.stopped.push(name) }
  }
}

test.afterEach(() => {
  delete (globalThis as Record<string, unknown>).__signalk_containerManager
  removeBridge()
})

function removeBridge (): void {
  delete (globalThis as Record<string, unknown>).__signalk_binnacle_routeOnWater
}

test('the plugin exposes id, name, and a schema', () => {
  const plugin = createPlugin(fakeApp() as never)
  assert.equal(plugin.id, 'signalk-binnacle-companion')
  assert.equal(plugin.name, 'Binnacle Companion')
  const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
  assert.equal((schema as { type: string }).type, 'object')
})

test('start sets a plugin error and does nothing when the container manager is missing', async () => {
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(app.errors.length, 1)
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('start launches the container and installs the bridge when the runtime is ready', async () => {
  const record = { ensured: [] as Array<{ name: string; config: ContainerConfig }>, stopped: [] as string[] }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = fakeManager(record)
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(record.ensured.length, 1)
  assert.equal(record.ensured[0].name, ROUTER_CONTAINER_NAME)
  assert.ok(getRouteOnWaterBridge() !== undefined)
  assert.equal(app.status.length, 1)
})

test('stop removes the bridge and stops the container', async () => {
  const record = { ensured: [] as Array<{ name: string; config: ContainerConfig }>, stopped: [] as string[] }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = fakeManager(record)
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  await plugin.stop()
  assert.equal(getRouteOnWaterBridge(), undefined)
  assert.deepEqual(record.stopped, [ROUTER_CONTAINER_NAME])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, the module `../src/plugin/plugin.js` cannot be resolved.

- [ ] **Step 3: Create `src/plugin/plugin.ts`**

```typescript
/** The plugin factory: lifecycle that launches the router container and publishes the in-process bridge. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION } from '../shared/plugin-id.js'
import { requireContainerManager, getContainerManager, ensureRuntimeReady } from '../runtime/container-manager.js'
import { ROUTER_CONTAINER_NAME, startRouterContainer, probeRouterHealth } from '../runtime/router-container.js'
import { installRouteOnWaterBridge, removeRouteOnWaterBridge, createSkeletonBridge } from '../bridge/route-on-water-bridge.js'

interface CompanionConfig {
  imageTag?: string
}

export function createPlugin (app: ServerAPI): Plugin {
  let started = false

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    schema: () => ({
      type: 'object',
      properties: {
        imageTag: {
          type: 'string',
          title: 'Router container image tag',
          description: 'The image tag to run for the router container.',
          default: 'latest'
        }
      }
    }),
    async start (config: CompanionConfig) {
      const manager = requireContainerManager(app)
      if (!manager) return
      if (!(await ensureRuntimeReady(app, manager))) return

      const address = await startRouterContainer(manager, { tag: config?.imageTag })
      installRouteOnWaterBridge(createSkeletonBridge(address, probeRouterHealth))
      started = true
      app.setPluginStatus(`Router container running and reachable at ${address}.`)
    },
    async stop () {
      if (!started) return
      removeRouteOnWaterBridge()
      const manager = getContainerManager()
      if (manager) await manager.stop(ROUTER_CONTAINER_NAME)
      started = false
    }
  }
}
```

- [ ] **Step 4: Create `src/index.ts`**

```typescript
/** Signal K plugin entrypoint. All wiring lives in the plugin factory. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { createPlugin } from './plugin/plugin.js'

export = function (app: ServerAPI): Plugin {
  return createPlugin(app)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, all plugin tests pass.

- [ ] **Step 6: Verify typecheck, lint, and build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all exit 0, `dist/index.js` is emitted.

- [ ] **Step 7: Commit**

```bash
git add src/plugin/plugin.ts src/index.ts test/plugin.test.ts
git commit -m "feat: plugin lifecycle launches the router container and bridge"
```

---

### Task 7: The Rust router container service

**Files:**
- Create: `container/router/Cargo.toml`
- Create: `container/router/src/lib.rs`
- Create: `container/router/src/main.rs`
- Test: `container/router/tests/http_test.rs`

**Interfaces:**
- Consumes: nothing from the plugin (separate artifact).
- Produces: a `binnacle_router` library exposing `pub fn app() -> axum::Router` with `GET /health` returning `200 {"status":"ok"}` and `GET /regions` returning `200 []`, and a `router` binary that serves the app, defaulting to port 8080 (override with `ROUTER_PORT`), plus a `healthcheck` subcommand that exits 0 when the port is reachable and 1 otherwise.

- [ ] **Step 1: Create `container/router/Cargo.toml`**

```toml
[package]
name = "binnacle-router"
version = "0.1.0"
edition = "2021"

[lib]
name = "binnacle_router"
path = "src/lib.rs"

[[bin]]
name = "router"
path = "src/main.rs"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net"] }
serde_json = "1"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
```

- [ ] **Step 2: Write the failing test**

Create `container/router/tests/http_test.rs`:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use binnacle_router::app;
use http_body_util::BodyExt;
use tower::ServiceExt; // brings `oneshot` onto Router

#[tokio::test]
async fn health_returns_status_ok() {
    let response = app()
        .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["status"], "ok");
}

#[tokio::test]
async fn regions_returns_empty_array() {
    let response = app()
        .oneshot(Request::builder().uri("/regions").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(value.is_array());
    assert_eq!(value.as_array().unwrap().len(), 0);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd container/router && cargo test`
Expected: FAIL to compile, the `binnacle_router` crate has no `app` function yet.

- [ ] **Step 4: Create `container/router/src/lib.rs`**

```rust
use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

/// The HTTP surface of the router container. Milestone 1 exposes liveness and an
/// empty regions list; routing endpoints arrive in later milestones.
pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/regions", get(regions))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn regions() -> Json<Value> {
    Json(json!([]))
}
```

- [ ] **Step 5: Create `container/router/src/main.rs`**

```rust
use binnacle_router::app;
use std::env;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("healthcheck") {
        std::process::exit(healthcheck().await);
    }

    let port = router_port();
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind router port");
    println!("binnacle-router listening on 0.0.0.0:{port}");
    axum::serve(listener, app()).await.expect("serve router");
}

fn router_port() -> u16 {
    env::var("ROUTER_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080)
}

/// Liveness probe used by the container HEALTHCHECK: a successful TCP connect to
/// the listening port means the server is up. Exits 0 on success, 1 on failure.
async fn healthcheck() -> i32 {
    match tokio::net::TcpStream::connect(("127.0.0.1", router_port())).await {
        Ok(_) => 0,
        Err(_) => 1,
    }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd container/router && cargo test`
Expected: PASS, both tests pass. A `Cargo.lock` is generated.

- [ ] **Step 7: Commit**

```bash
git add container/router/Cargo.toml container/router/Cargo.lock container/router/src/lib.rs container/router/src/main.rs container/router/tests/http_test.rs
git commit -m "feat: add the rust router container service with health and regions"
```

---

### Task 8: The container image and end-to-end run

**Files:**
- Create: `container/Dockerfile`
- Create: `container/.dockerignore`

**Interfaces:**
- Consumes: the `container/router` crate from Task 7.
- Produces: a runnable image `signalk-binnacle-router:dev` whose `/health` returns `{"status":"ok"}`, whose `/regions` returns `[]`, and whose declared HEALTHCHECK reports `healthy`.

- [ ] **Step 1: Create `container/.dockerignore`**

```
router/target/
```

- [ ] **Step 2: Create `container/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS builder
WORKDIR /build
COPY router/Cargo.toml router/Cargo.lock ./
COPY router/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --bin router \
 && cp target/release/router /router

FROM gcr.io/distroless/cc-debian12 AS runtime
COPY --from=builder /router /router
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/router", "healthcheck"]
ENTRYPOINT ["/router"]
```

- [ ] **Step 3: Build the image**

The deployment runtime is Podman (signalk-container resolves the runtime over the Docker-API socket with Podman preferred, Docker fallback), so build with Podman so the image lands in the same local store signalk-container reads. Build in Docker image format, not Podman's default OCI: OCI silently drops the Dockerfile `HEALTHCHECK` (`HEALTHCHECK is not supported for OCI image format and will be ignored`), and the standalone health check below depends on the image carrying it.

Run: `podman build --format docker -t signalk-binnacle-router:dev -f container/Dockerfile container`
Expected: the build completes, no OCI HEALTHCHECK warning, and it tags `localhost/signalk-binnacle-router:dev`.

- [ ] **Step 4: Run the container and verify the endpoints**

Run:
```bash
podman run --rm -d --name binnacle-router-test -p 127.0.0.1:8080:8080 signalk-binnacle-router:dev
sleep 2
curl -s http://127.0.0.1:8080/health
echo
curl -s http://127.0.0.1:8080/regions
```
Expected: `/health` prints `{"status":"ok"}` and `/regions` prints `[]`.

- [ ] **Step 5: Verify the healthcheck reports healthy**

Run:
```bash
sleep 16
podman inspect --format '{{.State.Health.Status}}' binnacle-router-test
```
Expected: `healthy` (after the 15s start period). In production the plugin also supplies `ContainerConfig.healthcheck`, so signalk-container applies the same probe even on an image that ships none; the image `HEALTHCHECK` here is the standalone-run backstop.

- [ ] **Step 6: Stop the test container**

Run: `podman rm -f binnacle-router-test`
Expected: the container is removed.

- [ ] **Step 7: Commit**

```bash
git add container/Dockerfile container/.dockerignore
git commit -m "feat: build the router container image with a binary healthcheck"
```

---

## Self-Review

**Spec coverage (against the design doc, Milestone 1 in section 14):**
- "The Node plugin": Tasks 1, 6.
- "signalk-container runtime guard (globalThis.__signalk_containerManager, whenReady, getRuntime, fail clean if absent)": Task 3.
- "ensureRunning of a trivial Rust health service with signalkAccessiblePorts": Tasks 4 (config and launch), 7 (the Rust service), 8 (the image).
- "the in-process routeOnWater bridge stub": Task 5, installed by Task 6.
- "Proves the plumbing end to end on the Pi": Task 8 runs the image and verifies health; Task 6's integration test proves start launches the container and installs the bridge.
- Global constraints (no manual `ports` with `signalkAccessiblePorts`, equal memory and memorySwap, exec-form healthcheck, no GDAL or SpatiaLite in the runtime image, no `prepare` script, peerDependencies and signalk.requires): enforced in Tasks 1, 4, 8 and asserted in the Task 4 test.

Not in this milestone, by design (later plans): the storage tracer spike (Milestone 1.5), the Rust engine port, the geodata pipeline, the crows-nest cutover, multi-arch publish, and the offline depth-unverified caveat.

**Placeholder scan:** No "TBD", "TODO", or "implement later" in any step. The skeleton bridge returning `not-implemented` is a real, tested behavior for this milestone, not a placeholder, and its replacement is scoped to the cutover milestone.

**Type consistency:** `ContainerManager`, `ContainerConfig`, `RouteOnWaterBridge`, and `RouteOnWaterResult` are defined once in Task 2 and consumed unchanged in Tasks 3 through 6. `ROUTER_CONTAINER_NAME` and `ROUTER_INTERNAL_PORT` are defined in Task 4 and reused in Tasks 4 and 6. `BRIDGE_GLOBAL_KEY` is defined in Task 5 and matches the literal string the Task 6 test deletes. The Rust `app()` signature in Task 7 is consumed by both the test and `main.rs`.
