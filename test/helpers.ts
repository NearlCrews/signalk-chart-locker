/** Shared test fakes and global cleanup, hoisted so the lifecycle and runtime tests share one definition. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContainerConfig, ContainerManager, ContainerRuntimeInfo } from '../src/shared/types.js'
import { CONTAINER_MANAGER_GLOBAL_KEY } from '../src/runtime/container-manager.js'
import { removeRouteOnWaterBridge } from '../src/bridge/route-on-water-bridge.js'

/** A ServerAPI stand-in that records the status, error, and debug calls the plugin makes. */
export interface Recorder {
  status: string[]
  errors: string[]
  config: { configPath: string }
  /** True once the navigation.position unsubscribe returned by getSelfBus().onValue() is called. */
  positionUnsubCalled: boolean
  setPluginStatus (m: string): void
  setPluginError (m: string): void
  error (...args: unknown[]): void
  debug (...args: unknown[]): void
  getDataDirPath (): string
  registerResourceProvider (provider: unknown): void
  get (path: string, handler: unknown): void
  streambundle: { getSelfBus (path?: unknown): { onValue (cb: (value: unknown) => void): () => void } }
}

export function fakeApp (): Recorder {
  // One real temp directory per app, used for both the config path and the data dir, so the JSON state
  // persistence and the chart discovery in start() have a writable directory and never collide.
  const dir = mkdtempSync(join(tmpdir(), 'companion-test-'))
  let positionUnsubCalled = false
  const app: Recorder = {
    status: [],
    errors: [],
    config: { configPath: dir },
    get positionUnsubCalled () { return positionUnsubCalled },
    setPluginStatus (m) { app.status.push(m) },
    setPluginError (m) { app.errors.push(m) },
    error () {},
    debug () {},
    getDataDirPath () { return dir },
    registerResourceProvider () {},
    get () {},
    streambundle: { getSelfBus (_path?: unknown) { return { onValue () { return () => { positionUnsubCalled = true } } } } }
  }
  return app
}

/** Records the names and configs passed to ensureRunning and the names passed to stop. */
export interface ManagerRecord {
  ensured: Array<{ name: string; config: ContainerConfig }>
  stopped: string[]
}

export function managerRecord (): ManagerRecord {
  return { ensured: [], stopped: [] }
}

export interface FakeManagerOptions {
  /** The detected runtime; pass null to model a host with no Docker or Podman. Defaults to docker. */
  runtime?: ContainerRuntimeInfo | null
  /** The resolved container address; pass null to model a launch whose address never resolves. Defaults to a reachable address. */
  address?: string | null
  /** When supplied, ensureRunning and stop calls are appended to this record. */
  record?: ManagerRecord
}

/** A simple container manager fake: a detected docker runtime and a resolvable address by default. */
export function fakeManager (opts: FakeManagerOptions = {}): ContainerManager {
  const runtime = opts.runtime === undefined ? { runtime: 'docker' } : opts.runtime
  const address = opts.address === undefined ? '127.0.0.1:8080' : opts.address
  const record = opts.record
  return {
    async whenReady () {},
    getRuntime () { return runtime },
    async ensureRunning (name, config) { record?.ensured.push({ name, config }) },
    async resolveContainerAddress () { return address },
    async stop (name) { record?.stopped.push(name) }
  }
}

/** Publishes a container manager on the global signalk-container reads. */
export function setContainerManager (manager: ContainerManager): void {
  ;(globalThis as Record<string, unknown>)[CONTAINER_MANAGER_GLOBAL_KEY] = manager
}

/** Clears the container-manager and route-on-water bridge globals between tests. */
export function clearGlobals (): void {
  delete (globalThis as Record<string, unknown>)[CONTAINER_MANAGER_GLOBAL_KEY]
  removeRouteOnWaterBridge()
}
