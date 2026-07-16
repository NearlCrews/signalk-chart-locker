/** Shared test fakes and global cleanup, hoisted so the lifecycle and runtime tests share one definition. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContainerConfig, ContainerManager, ContainerRuntimeInfo, ContainerUpdateRegistration, ContainerVersionSource } from '../src/shared/types.js'
import type { RegionsRouter, RegionsRequest, RegionsResponse } from '../src/http/regions-routes.js'
import { CONTAINER_MANAGER_GLOBAL_KEY } from '../src/runtime/container-manager.js'

const helperTempDirs = new Set<string>()
process.once('exit', () => {
  for (const dir of helperTempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A ServerAPI stand-in that records the status, error, and debug calls the plugin makes. */
export interface Recorder {
  status: string[]
  errors: string[]
  config: { configPath: string }
  /** True once the navigation.position unsubscribe returned by getSelfBus().onValue() is called. */
  positionUnsubCalled: boolean
  positionUnsubCalls: number
  setPluginStatus (m: string): void
  setPluginError (m: string): void
  error (...args: unknown[]): void
  debug (...args: unknown[]): void
  getDataDirPath (): string
  registerResourceProvider (provider: unknown): void
  get (path: string, handler: unknown): void
  streambundle: { getSelfBus (path?: unknown): { onValue (cb: (value: unknown) => void): () => void } }
  securityStrategy: { addAdminMiddleware (path: string): void }
}

export function fakeApp (): Recorder {
  // One real temp directory per app, used for both the config path and the data dir, so the JSON state
  // persistence and the chart discovery in start() have a writable directory and never collide.
  const dir = mkdtempSync(join(tmpdir(), 'chart-locker-test-'))
  helperTempDirs.add(dir)
  let positionUnsubCalls = 0
  const app: Recorder = {
    status: [],
    errors: [],
    config: { configPath: dir },
    get positionUnsubCalled () { return positionUnsubCalls > 0 },
    get positionUnsubCalls () { return positionUnsubCalls },
    setPluginStatus (m) { app.status.push(m) },
    setPluginError (m) { app.errors.push(m) },
    error () {},
    debug () {},
    getDataDirPath () { return dir },
    registerResourceProvider () {},
    get () {},
    streambundle: { getSelfBus (_path?: unknown) { return { onValue () { return () => { positionUnsubCalls++ } } } } },
    securityStrategy: { addAdminMiddleware () {} }
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

/** Records the calls made through the fake manager's optional update-service surface. */
export interface UpdatesRecord {
  registered: ContainerUpdateRegistration[]
  unregistered: string[]
  checked: string[]
  /** The version-source sentinel returned by githubReleases for each repo, so a test can assert the registration carries the exact object. */
  sentinels: Map<string, ContainerVersionSource>
}

export function updatesRecord (): UpdatesRecord {
  return { registered: [], unregistered: [], checked: [], sentinels: new Map() }
}

export interface FakeManagerOptions {
  /** The detected runtime; pass null to model a host with no Docker or Podman. Defaults to docker. */
  runtime?: ContainerRuntimeInfo | null
  /** The resolved container address. Defaults to null so tests never contact an ambient localhost service. */
  address?: string | null
  /** When supplied, ensureRunning and stop calls are appended to this record. */
  record?: ManagerRecord
  /** When supplied, the fake gains an update-service surface and its calls are appended to this record. Omit to model an older signalk-container with no update service. */
  updates?: UpdatesRecord
  /** The operations that should throw: 'ensureRunning' models a container launch that fails, 'register' exercises the plugin's defensive try/catch around the update service. */
  throwsOn?: ReadonlyArray<'ensureRunning' | 'register'>
}

/** A simple container manager fake: a detected docker runtime and a resolvable address by default. */
export function fakeManager (opts: FakeManagerOptions = {}): ContainerManager {
  const runtime = opts.runtime === undefined ? { runtime: 'docker' } : opts.runtime
  const address = opts.address === undefined ? null : opts.address
  const record = opts.record
  const updates = opts.updates
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return runtime },
    async ensureRunning (name, config) {
      if (opts.throwsOn?.includes('ensureRunning')) throw new Error('ensureRunning failed')
      record?.ensured.push({ name, config })
    },
    async resolveContainerAddress () { return address },
    async stop (name) { record?.stopped.push(name) }
  }
  if (updates) {
    manager.updates = {
      register (reg) {
        if (opts.throwsOn?.includes('register')) throw new Error('register failed')
        updates.registered.push(reg)
      },
      unregister (pluginId) { updates.unregistered.push(pluginId) },
      async checkOne (pluginId) { updates.checked.push(pluginId); return null },
      sources: {
        githubReleases (repo) {
          const sentinel: ContainerVersionSource = { fetch: async () => null }
          updates.sentinels.set(repo, sentinel)
          return sentinel
        }
      }
    }
  }
  return manager
}

/** Publishes a container manager on the global signalk-container reads. */
export function setContainerManager (manager: ContainerManager): void {
  ;(globalThis as Record<string, unknown>)[CONTAINER_MANAGER_GLOBAL_KEY] = manager
}

/** Clears the container-manager global between tests. */
export function clearGlobals (): void {
  delete (globalThis as Record<string, unknown>)[CONTAINER_MANAGER_GLOBAL_KEY]
}

/** One recorded route mount from the RegionsRouter fake. */
export interface RecordedRoute {
  method: string
  path: string
  handler: (req: RegionsRequest, res: RegionsResponse) => void | Promise<void>
}

/** A RegionsRouter that records every mounted route, shared by the region, cache, and geocode route tests. */
export function makeRegionsRouter (): { routes: RecordedRoute[], router: RegionsRouter } {
  const routes: RecordedRoute[] = []
  const router: RegionsRouter = {
    get (path, handler) { routes.push({ method: 'GET', path, handler }) },
    post (path, handler) { routes.push({ method: 'POST', path, handler }) },
    delete (path, handler) { routes.push({ method: 'DELETE', path, handler }) }
  }
  return { routes, router }
}

/** A RegionsResponse that records each status and its body, shared across the route tests. */
export function fakeRegionsRes (): { responded: Array<{ status: number, body: unknown }>, res: RegionsResponse } {
  const responded: Array<{ status: number, body: unknown }> = []
  const res: RegionsResponse = {
    status (code) { responded.push({ status: code, body: null }); return res },
    json (body) { const last = responded[responded.length - 1]; if (last) last.body = body },
    end () { const last = responded[responded.length - 1]; if (last) last.body = null }
  }
  return { responded, res }
}
