// test/plugin-charts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin } from '../src/plugin/plugin.js'
import { fakeApp, fakeManager, setContainerManager, clearGlobals, statusSlot } from './helpers.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

interface ChartApp extends ReturnType<typeof fakeApp> {
  config: { configPath: string }
  getDataDirPath: () => string
  registerResourceProvider: (provider: unknown) => void
  get: (path: string, handler: unknown) => void
}

async function configRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sk-'))
  await mkdir(join(root, 'charts', 'pmtiles'), { recursive: true })
  return root
}

function chartApp (configPath: string): { app: ChartApp, providers: unknown[], routes: Record<string, unknown> } {
  const providers: unknown[] = []
  const routes: Record<string, unknown> = {}
  const app = {
    ...fakeApp(),
    config: { configPath },
    getDataDirPath: () => configPath,
    registerResourceProvider: (p: unknown) => providers.push(p),
    get: (path: string, handler: unknown) => { routes[path] = handler }
  } as ChartApp
  return { app, providers, routes }
}

test('doStart discovers charts and registers the provider when the third-party plugin is absent', async () => {
  const root = await configRoot()
  await writeFile(join(root, 'charts', 'pmtiles', 'good.pmtiles'), buildPmtilesFixture())
  setContainerManager(fakeManager())
  const { app, providers } = chartApp(root)
  const plugin = createPlugin(app as never)
  try {
    await plugin.start({}, () => {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(providers.length, 1)
  } finally {
    await plugin.stop()
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('doStart discovers PMTiles charts when the container manager is unavailable', async () => {
  const root = await configRoot()
  await writeFile(join(root, 'charts', 'pmtiles', 'good.pmtiles'), buildPmtilesFixture())
  clearGlobals()
  const { app, providers } = chartApp(root)
  const plugin = createPlugin(app as never)
  try {
    await plugin.start({}, () => {})
    assert.equal(providers.length, 1)
    // The server keeps one status slot, so assert what an operator actually ends up seeing. With no
    // container manager the slot holds the actionable error, and it still says charts are ready.
    const slot = statusSlot(app)
    assert.equal(slot?.type, 'error')
    assert.match(slot!.message, /signalk-container plugin is required but was not found/)
    assert.match(slot!.message, /PMTiles charts ready/)
  } finally {
    await plugin.stop()
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('a chart start that fails before the container work is not a process-level unhandled rejection', async () => {
  const root = await configRoot()
  const { app } = chartApp(root)
  // The override store rethrows any read failure that is not ENOENT. A directory here reproduces in a
  // portable way what EACCES does in the field: syncCharts rejects synchronously, well before the
  // first real await on it, so a stored promise with no handler escapes to the process.
  await mkdir(join(root, 'pmtiles-overrides.json'), { recursive: true })
  const manager = fakeManager()
  // A real signalk-container readiness check does I/O, so startup yields to the macrotask queue before
  // the first await on the chart work. That is the window in which an unhandled rejection is reported.
  manager.whenReady = async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }
  setContainerManager(manager)
  const escaped: unknown[] = []
  const record = (reason: unknown): void => { escaped.push(reason) }
  process.on('unhandledRejection', record)
  const plugin = createPlugin(app as never)
  try {
    await plugin.start({}, () => {})
    // Two turns of the microtask and macrotask queues: Node reports an unhandled rejection after the
    // queue drains, so a synchronous assertion here would pass either way.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(escaped, [])
    // The failure still has to reach the operator, through the startup error rather than the log.
    assert.ok(app.errors.some((message) => message.includes('Startup failed')))
  } finally {
    process.off('unhandledRejection', record)
    await plugin.stop()
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('doStart does not register charts when the third-party plugin is enabled, and surfaces the conflict', async () => {
  const root = await configRoot()
  await mkdir(join(root, 'plugin-config-data'), { recursive: true })
  await writeFile(join(root, 'plugin-config-data', 'pmtiles-chart-provider.json'), JSON.stringify({ enabled: true }))
  setContainerManager(fakeManager())
  const { app, providers } = chartApp(root)
  const plugin = createPlugin(app as never)
  try {
    await plugin.start({}, () => {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(providers.length, 0)
    const statusMessage = app.status.find((s) => /signalk-pmtiles-plugin/i.test(s))
    assert(statusMessage !== undefined, 'Status should contain pmtiles-plugin conflict note')
    assert(/Tilecache container unavailable/.test(statusMessage), 'Status should explain that no container address resolved')
    assert(/signalk-pmtiles-plugin/i.test(statusMessage), 'Status should contain conflict note')
  } finally {
    await plugin.stop()
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('registerWithRouter mounts chart reads through the readonly access scope', async () => {
  const root = await configRoot()
  setContainerManager(fakeManager())
  const { app } = chartApp(root)
  const plugin = createPlugin(app as never)
  const routerRoutes: Record<string, unknown> = {}
  const readonlyRoutes: Record<string, unknown> = {}
  const accessLevels: string[] = []
  try {
    plugin.registerWithRouter?.({
      get: (p: string, h: unknown) => { routerRoutes[p] = h },
      post: (p: string, h: unknown) => { routerRoutes[p] = h },
      delete: (p: string, h: unknown) => { routerRoutes[p] = h },
      access: (level: string) => {
        accessLevels.push(level)
        return { get: (p: string, h: unknown) => { readonlyRoutes[p] = h } }
      }
    } as never)
    assert.deepEqual(accessLevels, ['readonly'])
    assert.equal(typeof readonlyRoutes['/tiles/ready'], 'function')
    assert.equal(typeof readonlyRoutes['/tile/:source/:z/:x/:y'], 'function')
    assert.equal(typeof readonlyRoutes['/style/:source'], 'function')
    assert.equal(typeof readonlyRoutes['/style/:source/*'], 'function')
    assert.equal(typeof readonlyRoutes['/pmtiles/:file'], 'function')
    assert.equal(routerRoutes['/tiles/ready'], undefined)
    assert.equal(routerRoutes['/pmtiles/:file'], undefined)
  } finally {
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('registerWithRouter preserves legacy public read routes when scoped routers are unavailable', async () => {
  const root = await configRoot()
  setContainerManager(fakeManager())
  const { app } = chartApp(root)
  const plugin = createPlugin(app as never)
  const routerRoutes: Record<string, unknown> = {}
  try {
    plugin.registerWithRouter?.({
      get: (p: string, h: unknown) => { routerRoutes[p] = h },
      post: (p: string, h: unknown) => { routerRoutes[p] = h },
      delete: (p: string, h: unknown) => { routerRoutes[p] = h }
    } as never)
    assert.equal(typeof routerRoutes['/tiles/ready'], 'function')
    assert.equal(typeof routerRoutes['/tile/:source/:z/:x/:y'], 'function')
    assert.equal(typeof routerRoutes['/style/:source'], 'function')
    assert.equal(typeof routerRoutes['/style/:source/*'], 'function')
    assert.equal(typeof routerRoutes['/pmtiles/:file'], 'function')
  } finally {
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('registerWithRouter does not mount management routes when no security strategy is present', async () => {
  const root = await configRoot()
  setContainerManager(fakeManager())
  const { app } = chartApp(root)
  // Model a server with no security strategy: strip the helper default so the admin gate fails closed.
  delete (app as unknown as Record<string, unknown>).securityStrategy
  const plugin = createPlugin(app as never)
  const routerRoutes: Record<string, unknown> = {}
  try {
    plugin.registerWithRouter?.({
      get: (p: string, h: unknown) => { routerRoutes[p] = h },
      post: (p: string, h: unknown) => { routerRoutes[p] = h },
      delete: (p: string, h: unknown) => { routerRoutes[p] = h }
    } as never)
    assert.equal(routerRoutes['/api/charts'], undefined, '/api/charts must not be registered without a security strategy')
    assert.equal(routerRoutes['/api/charts/:id/override'], undefined, '/api/charts/:id/override must not be registered without a security strategy')
  } finally {
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('registerWithRouter mounts management routes when a security strategy is present', async () => {
  const root = await configRoot()
  setContainerManager(fakeManager())
  const { app } = chartApp(root)
  ;(app as unknown as Record<string, unknown>).securityStrategy = { addAdminMiddleware: () => {} }
  const plugin = createPlugin(app as never)
  const routerRoutes: Record<string, unknown> = {}
  try {
    plugin.registerWithRouter?.({
      get: (p: string, h: unknown) => { routerRoutes[p] = h },
      post: (p: string, h: unknown) => { routerRoutes[p] = h },
      delete: (p: string, h: unknown) => { routerRoutes[p] = h }
    } as never)
    assert.equal(typeof routerRoutes['/api/charts'], 'function', '/api/charts must be registered with a security strategy')
    assert.equal(typeof routerRoutes['/api/charts/:id/override'], 'function', '/api/charts/:id/override must be registered with a security strategy')
  } finally {
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('live third-party enable and disable transitions clear and restore chart resources', async () => {
  const root = await configRoot()
  const configFile = join(root, 'plugin-config-data', 'pmtiles-chart-provider.json')
  await mkdir(join(root, 'plugin-config-data'), { recursive: true })
  await writeFile(join(root, 'charts', 'pmtiles', 'good.pmtiles'), buildPmtilesFixture())
  await writeFile(configFile, JSON.stringify({ enabled: false }))
  setContainerManager(fakeManager())
  const { app, providers } = chartApp(root)
  const plugin = createPlugin(app as never, { mutualExclusionPollIntervalMs: 10 })
  const resources = async (): Promise<Record<string, unknown>> => {
    const provider = providers[0] as { methods: { listResources: () => Promise<Record<string, unknown>> } }
    return provider.methods.listResources()
  }
  const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 3000
    while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(await predicate(), true)
  }
  try {
    await plugin.start({}, () => {})
    assert.equal(Object.keys(await resources()).length, 1)
    await writeFile(configFile, JSON.stringify({ enabled: true }))
    await waitUntil(async () => Object.keys(await resources()).length === 0)
    await writeFile(configFile, JSON.stringify({ enabled: false }))
    await waitUntil(async () => Object.keys(await resources()).length === 1)
    assert.equal(providers.length, 1, 'the resource provider is registered only once')
  } finally {
    await plugin.stop()
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})
