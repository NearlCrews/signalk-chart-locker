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

test('registerWithRouter mounts the open serve route', async () => {
  const root = await configRoot()
  setContainerManager(fakeManager())
  const { app } = chartApp(root)
  const plugin = createPlugin(app as never)
  const routerRoutes: Record<string, unknown> = {}
  try {
    plugin.registerWithRouter?.({ get: (p: string, h: unknown) => { routerRoutes[p] = h } } as never)
    assert.equal(typeof routerRoutes['/pmtiles/:file'], 'function')
  } finally {
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})
