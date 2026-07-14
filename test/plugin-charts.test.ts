// test/plugin-charts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin } from '../src/plugin/plugin.js'
import { fakeApp, fakeManager, setContainerManager, clearGlobals } from './helpers.js'
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
    assert.ok(app.status.some((status) => status.includes('PMTiles charts ready')))
  } finally {
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
    assert(/127\.0\.0\.1:8080/.test(statusMessage), 'Status should contain router address')
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
