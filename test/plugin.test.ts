import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlugin } from '../src/plugin/plugin.js'
import { PLUGIN_ID, PLUGIN_NAME } from '../src/shared/plugin-id.js'
import { TILECACHE_CONTAINER_NAME, DEFAULT_TILECACHE_IMAGE, DEFAULT_TILECACHE_TAG } from '../src/runtime/tilecache-container.js'
import { fakeApp, fakeManager, managerRecord, updatesRecord, setContainerManager, clearGlobals } from './helpers.js'

test.afterEach(() => {
  clearGlobals()
})

test('the plugin exposes id, name, and a schema', () => {
  const plugin = createPlugin(fakeApp() as never)
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal(plugin.name, PLUGIN_NAME)
  const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
  assert.equal((schema as { type: string }).type, 'object')
})

test('createPlugin does not call getDataDirPath at construction', () => {
  // The Signal K server (interfaces/plugins.js) calls the plugin factory, then assigns
  // appCopy.getDataDirPath afterward, so getDataDirPath is absent while the factory runs. The plugin
  // must defer every getDataDirPath call to start or registerWithRouter, never the constructor.
  const appWithoutDataDir = {
    config: { configPath: '/tmp' },
    debug () {},
    setPluginStatus () {},
    setPluginError () {}
  }
  assert.doesNotThrow(() => createPlugin(appWithoutDataDir as never))
})

test('start sets a plugin error and does nothing when the container manager is missing', async () => {
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(app.errors.length, 1)
})

test('start rejects configuration that bypasses the panel validation', async () => {
  setContainerManager(fakeManager())
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({ tileCache: { cacheCapGiB: 8, regionsBudgetGiB: 9 } }, () => {})
  assert.ok(app.errors.some((message) => message.includes('regionsBudgetGiB')))
})

test('stop with no prior start and a manager present is a clean no-op', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(async () => { await plugin.stop() })
  assert.deepEqual(record.stopped, [])
})

test('schema() cap field is integer with fixed maximum 32, minimum 4, and default >= 4', () => {
  const plugin = createPlugin(fakeApp() as never)
  const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
  const props = (schema as { properties: Record<string, { properties: Record<string, unknown> }> }).properties
  const cap = props.tileCache.properties.cacheCapGiB as {
    type: string
    maximum: number
    minimum: number
    default: number
    multipleOf: number
  }
  assert.equal(cap.type, 'integer')
  assert.equal(cap.maximum, 32)
  assert.equal(cap.minimum, 4)
  assert.ok(cap.default >= 4, 'default must be at least 4')
  assert.equal(cap.default % 4, 0, 'default must be a multiple of 4')
  assert.equal(cap.multipleOf, 1)
})

test('plugin exposes uiSchema with a range widget on the cap field', () => {
  const plugin = createPlugin(fakeApp() as never)
  const ui = (plugin as unknown as { uiSchema: Record<string, Record<string, { 'ui:widget': string }>> }).uiSchema
  assert.ok(ui != null, 'uiSchema must be present')
  assert.equal(ui.tileCache.cacheCapGiB['ui:widget'], 'range')
})

test('stop calls the navigation.position unsubscribe returned by streambundle', async () => {
  setContainerManager(fakeManager())
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(app.positionUnsubCalled, false)
  await plugin.stop()
  assert.equal(app.positionUnsubCalled, true)
})

test('start registers the tilecache with the update service exactly once', async () => {
  const updates = updatesRecord()
  setContainerManager(fakeManager({ updates }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(updates.registered.length, 1)
  const reg = updates.registered[0]
  assert.equal(reg.pluginId, PLUGIN_ID)
  assert.equal(reg.containerName, TILECACHE_CONTAINER_NAME)
  assert.equal(reg.image, DEFAULT_TILECACHE_IMAGE)
  assert.equal(reg.currentTag(), DEFAULT_TILECACHE_TAG)
  // The version source must be the exact sentinel built for this plugin's public repo, and the
  // GitHub source factory must be asked for that repo and no other.
  assert.deepEqual([...updates.sentinels.keys()], ['NearlCrews/signalk-chart-locker'])
  assert.strictEqual(reg.versionSource, updates.sentinels.get('NearlCrews/signalk-chart-locker'))
  // The detached initial check runs so the badge populates without waiting for the scheduled check.
  assert.deepEqual(updates.checked, [PLUGIN_ID])
  await plugin.stop()
})

test('the registration currentTag reflects a trimmed configured image tag', async () => {
  const updates = updatesRecord()
  setContainerManager(fakeManager({ updates }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({ advanced: { imageTag: ' v9.9.9 ' } }, () => {})
  assert.equal(updates.registered.length, 1)
  assert.equal(updates.registered[0].currentTag(), 'v9.9.9')
  await plugin.stop()
})

test('start completes against an older manager with no update service', async () => {
  setContainerManager(fakeManager())
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(async () => { await plugin.start({}, () => {}) })
  await plugin.stop()
})

test('a throwing update-service register does not break start', async () => {
  // The real update service never throws on validation: it logs and returns, so this exercises only
  // the plugin's defensive try/catch around register. The container still launches, and doStart
  // completes to its final status.
  const updates = updatesRecord()
  setContainerManager(fakeManager({ updates, throwsOn: ['register'] }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(async () => { await plugin.start({}, () => {}) })
  assert.deepEqual(updates.registered, [])
  assert.deepEqual(updates.checked, [])
  assert.ok(app.status.some(s => s.startsWith('Tilecache at')), 'doStart must reach its final tilecache status')
  await plugin.stop()
})

test('stop after start unregisters the update service', async () => {
  const updates = updatesRecord()
  setContainerManager(fakeManager({ updates }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  await plugin.stop()
  assert.deepEqual(updates.unregistered, [PLUGIN_ID])
})

test('a failed container launch skips update-service registration', async () => {
  const updates = updatesRecord()
  setContainerManager(fakeManager({ updates, throwsOn: ['ensureRunning'] }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.deepEqual(updates.registered, [])
  await plugin.stop()
})

test('stop without a prior start does not unregister', async () => {
  const updates = updatesRecord()
  setContainerManager(fakeManager({ updates }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.stop()
  assert.deepEqual(updates.unregistered, [])
})

test('startup marks a saved region for re-download when its cache pins disappeared', async (t) => {
  setContainerManager(fakeManager())
  const app = fakeApp()
  const { addRegion, loadRegionsStore } = await import('../src/runtime/regions-store.js')
  addRegion(app.getDataDirPath(), {
    id: 'region-1',
    name: 'Offline area',
    bbox: [-1, -1, 1, 1],
    sourceIds: ['source'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: 2,
    bytes: 100,
    status: 'ready'
  })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    if (url.endsWith('/config')) return new Response(null, { status: 204 })
    if (url.endsWith('/cache/regions')) return new Response(JSON.stringify({ regions: {} }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  })
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  const region = loadRegionsStore(app.getDataDirPath()).regions[0]!
  assert.equal(region.status, 'needs-redownload')
  assert.equal(region.bytes, 0)
  await plugin.stop()
})
