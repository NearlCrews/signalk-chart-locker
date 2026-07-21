import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlugin } from '../src/plugin/plugin.js'
import { PLUGIN_ID, PLUGIN_NAME } from '../src/shared/plugin-id.js'
import { TILECACHE_CONTAINER_NAME, DEFAULT_TILECACHE_IMAGE, DEFAULT_TILECACHE_TAG } from '../src/runtime/tilecache-container.js'
import { fakeApp, fakeManager, managerRecord, updatesRecord, setContainerManager, clearGlobals } from './helpers.js'

async function waitUntil (predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

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
  await plugin.stop()
})

test('start rejects malformed configuration that bypasses the panel validation', async () => {
  setContainerManager(fakeManager())
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({ tileCache: { cacheCapGiB: 3.5, regionsBudgetGiB: 0 } }, () => {})
  assert.ok(app.errors.some((message) => message.includes('cacheCapGiB')))
})

test('start rejects oversized and control-bearing filesystem paths before manager access', async () => {
  const cases: Array<{ config: unknown, field: string }> = [
    { config: { charts: { path: 'charts/\u0000bad' } }, field: 'charts.path' },
    { config: { charts: { path: 'charts/\u0085bad' } }, field: 'charts.path' },
    { config: { advanced: { cacheVolumeSource: '/media/\u2028bad' } }, field: 'cacheVolumeSource' },
    { config: { advanced: { cacheVolumeSource: '/media/\u2029bad' } }, field: 'cacheVolumeSource' },
    { config: { charts: { path: 'x'.repeat(4097) } }, field: 'charts.path' },
    { config: { advanced: { cacheVolumeSource: `/${'x'.repeat(4096)}` } }, field: 'cacheVolumeSource' }
  ]

  for (const { config, field } of cases) {
    const record = managerRecord()
    setContainerManager(fakeManager({ record }))
    const app = fakeApp()
    const plugin = createPlugin(app as never)
    await plugin.start(config as never, () => {})
    assert.ok(app.errors.some((message) => message.includes(field)), field)
    assert.deepEqual(record.ensured, [], field)
    await plugin.stop()
  }
})

test('start preserves a legitimate absolute external-drive path', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record, address: null }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({ advanced: { cacheVolumeSource: ' /media/Chart Locker SSD ' } }, () => {})
  assert.deepEqual(app.errors, [])
  assert.deepEqual(record.ensured[0]?.config.volumes?.['/signalk-data/chart-locker-tilecache'], {
    source: '/media/Chart Locker SSD',
    ifMissing: 'abort'
  })
  await plugin.stop()
})

test('start reports an unavailable configured external cache path without silently falling back', async () => {
  const record = managerRecord()
  const manager = fakeManager({ record })
  manager.ensureRunning = async (_name, _config, options) => {
    await options?.onVolumeIssue?.({
      containerPath: '/signalk-data/chart-locker-tilecache',
      source: '/media/offline-drive/cache',
      action: 'aborted',
      reason: 'required host path is missing'
    })
    throw new Error('required host path is missing')
  }
  setContainerManager(manager)
  const app = fakeApp()
  const plugin = createPlugin(app as never)

  await plugin.start({ advanced: { cacheVolumeSource: '/media/offline-drive/cache' } }, () => {})

  assert.ok(app.errors.some((message) => message.includes('/media/offline-drive/cache')))
  assert.ok(app.status.some((message) => message.includes('Tilecache container unavailable')))
  assert.deepEqual(record.stopped, [TILECACHE_CONTAINER_NAME])
  await plugin.stop()
})

test('start migrates legacy cache limits accepted before 0.4.3', async () => {
  for (const [storedCap, storedBudget, expectedCap] of [[2, 9, 4], [100, 50, 32]]) {
    const record = managerRecord()
    setContainerManager(fakeManager({ record, address: null }))
    const app = fakeApp()
    const plugin = createPlugin(app as never)

    await plugin.start({ tileCache: { cacheCapGiB: storedCap, regionsBudgetGiB: storedBudget } }, () => {})

    assert.deepEqual(app.errors, [])
    assert.equal(record.ensured.length, 1)
    assert.equal(record.ensured[0]?.config.env?.TILECACHE_CAP_BYTES, String(expectedCap * 1024 ** 3))
    await plugin.stop()
  }
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

test('start migrates a skipped-release schema default to the current container image', async () => {
  const updates = updatesRecord()
  const record = managerRecord()
  setContainerManager(fakeManager({ updates, record, address: null }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({ advanced: { imageTag: ' v0.1.0 ' } }, () => {})
  assert.equal(record.ensured[0]?.config.tag, DEFAULT_TILECACHE_TAG)
  assert.equal(updates.registered[0]?.currentTag(), DEFAULT_TILECACHE_TAG)
  await plugin.stop()
})

test('start completes against an older manager with no update service', async () => {
  setContainerManager(fakeManager())
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(async () => { await plugin.start({}, () => {}) })
  await plugin.stop()
})

test('stop cancels startup when the container manager never becomes ready', async () => {
  const manager = fakeManager()
  manager.whenReady = async () => await new Promise<void>(() => {})
  setContainerManager(manager)
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  const starting = plugin.start({}, () => {})
  await new Promise((resolve) => setImmediate(resolve))
  const stopping = plugin.stop()
  await Promise.all([starting, stopping])
  assert.equal(app.errors.some((message) => message.includes('startup timeout')), false)
})

test('stop aborts an in-flight startup container fetch instead of waiting for its timeout', async (t) => {
  setContainerManager(fakeManager({ address: '127.0.0.1:8080' }))
  const app = fakeApp()
  let started: (() => void) | undefined
  const healthStarted = new Promise<void>((resolve) => { started = resolve })
  let aborted = false
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.endsWith('/health')) throw new Error(`unexpected fetch ${url}`)
    started?.()
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  })
  const plugin = createPlugin(app as never)
  const starting = plugin.start({}, () => {})
  await healthStarted
  const beganStopping = Date.now()
  const stopping = plugin.stop()
  await Promise.all([starting, stopping])
  assert.equal(aborted, true)
  assert.ok(Date.now() - beganStopping < 1000)
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
  assert.ok(app.status.some(s => s.startsWith('Tilecache container unavailable')), 'doStart must reach its final tilecache status')
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
  setContainerManager(fakeManager({ address: '127.0.0.1:8080' }))
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

test('startup refreshes durable terminal region bytes from authoritative cache totals', async (t) => {
  setContainerManager(fakeManager({ address: '127.0.0.1:8080' }))
  const app = fakeApp()
  const { addRegion, loadRegionsStore } = await import('../src/runtime/regions-store.js')
  addRegion(app.getDataDirPath(), {
    id: 'region-authoritative',
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
    if (url.endsWith('/health')) return Response.json({ status: 'ok' })
    if (url.endsWith('/config')) return new Response(null, { status: 204 })
    if (url.endsWith('/cache/regions')) return Response.json({ regions: { 'region-authoritative': 55 } })
    throw new Error(`unexpected fetch ${url}`)
  })
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  try {
    const region = loadRegionsStore(app.getDataDirPath()).regions[0]!
    assert.equal(region.status, 'ready')
    assert.equal(region.bytes, 55)
  } finally {
    await plugin.stop()
  }
})

test('startup re-probes health after a successful configuration push', async (t) => {
  setContainerManager(fakeManager({ address: '127.0.0.1:8080' }))
  const app = fakeApp()
  let healthCalls = 0
  let configToken: string | null = null
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/health')) {
      healthCalls++
      return healthCalls === 1
        ? new Response('{}', { status: 503 })
        : Response.json({ status: 'ok' })
    }
    if (url.endsWith('/config')) {
      configToken = (init?.headers as Record<string, string>)['x-tilecache-token'] ?? null
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/cache/regions')) return Response.json({ regions: {} })
    throw new Error(`unexpected fetch ${url}`)
  })
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  try {
    assert.equal(healthCalls, 2)
    assert.ok(configToken)
    assert.ok(app.status.some((status) => status.includes('; ready.')))
  } finally {
    await plugin.stop()
  }
})

test('a configuration rejection takes priority over an earlier failed startup health probe', async (t) => {
  setContainerManager(fakeManager({ address: '127.0.0.1:31001' }))
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/health')) return Response.json({}, { status: 503 })
    if (url.endsWith('/config')) return Response.json({ error: 'source configuration rejected' }, { status: 400 })
    if (url.endsWith('/cache/regions')) return Response.json({ regions: {} })
    throw new Error(`unexpected fetch ${url}`)
  })
  const app = fakeApp()
  const plugin = createPlugin(app as never, { hostHealthMonitorIntervalMs: 60_000 })

  await plugin.start({}, () => {})
  try {
    assert.ok(app.status.some((status) => status.includes('configuration push failed')))
  } finally {
    await plugin.stop()
  }
})

test('host-side recovery recreates the container, re-resolves its port, and restores configuration', async (t) => {
  const record = managerRecord()
  const manager = fakeManager({ record })
  let address: string | null = '127.0.0.1:31001'
  let firstAddressHealthCalls = 0
  let configPushes = 0
  manager.resolveContainerAddress = async () => address
  manager.recreate = async (name, config) => {
    record.recreated.push({ name, config })
    address = '127.0.0.1:31002'
  }
  manager.stop = async (name) => { record.stopped.push(name); address = null }
  setContainerManager(manager)
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/health')) {
      if (url.includes('31002')) return Response.json({ status: 'ok' })
      firstAddressHealthCalls++
      return firstAddressHealthCalls <= 2
        ? Response.json({ status: 'ok' })
        : Response.json({}, { status: 503 })
    }
    if (url.endsWith('/config')) {
      configPushes++
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/cache/regions')) return Response.json({ regions: {} })
    throw new Error(`unexpected fetch ${url}`)
  })
  const app = fakeApp()
  const plugin = createPlugin(app as never, {
    hostHealthMonitorIntervalMs: 5,
    hostHealthFailureThreshold: 1,
    hostHealthRecoveryCooldownMs: 0
  })

  await plugin.start({}, () => {})
  try {
    await waitUntil(() => record.recreated.length >= 1 && configPushes >= 2)

    assert.equal(record.recreated.length, 1)
    assert.equal(record.recreated[0]?.name, TILECACHE_CONTAINER_NAME)
    assert.equal(configPushes, 2)
    assert.ok(app.status.some((status) => status.includes('; ready.')))
  } finally {
    await plugin.stop()
  }
  assert.deepEqual(record.stopped, [TILECACHE_CONTAINER_NAME])
})

test('an initially unconfigured but reachable container is restored by host monitoring', async (t) => {
  const record = managerRecord()
  const manager = fakeManager({ record, address: '127.0.0.1:31001' })
  setContainerManager(manager)
  let healthCalls = 0
  let configPushes = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/health')) {
      healthCalls++
      return healthCalls === 1
        ? Response.json({}, { status: 503 })
        : Response.json({ status: 'ok' })
    }
    if (url.endsWith('/config')) {
      configPushes++
      return configPushes === 1
        ? Response.json({ error: 'port forward unavailable' }, { status: 400 })
        : new Response(null, { status: 204 })
    }
    if (url.endsWith('/cache/regions')) return Response.json({ regions: {} })
    throw new Error(`unexpected fetch ${url}`)
  })
  const app = fakeApp()
  const plugin = createPlugin(app as never, {
    hostHealthMonitorIntervalMs: 5,
    hostHealthFailureThreshold: 1,
    hostHealthRecoveryCooldownMs: 0
  })

  await plugin.start({}, () => {})
  try {
    await waitUntil(() => configPushes >= 2)

    assert.equal(configPushes, 2)
    assert.equal(record.recreated.length, 0)
    assert.ok(app.status.some((status) => status.includes('; ready.')))
  } finally {
    await plugin.stop()
  }
})

test('an out-of-band configuration loss keeps public tile routes unavailable when restore fails', async (t) => {
  setContainerManager(fakeManager({ address: '127.0.0.1:31001' }))
  let healthCalls = 0
  let configPushes = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/health')) {
      healthCalls++
      return Response.json({ status: 'ok', configured: healthCalls <= 2 })
    }
    if (url.endsWith('/config')) {
      configPushes++
      return configPushes === 1
        ? new Response(null, { status: 204 })
        : Response.json({ error: 'source restore rejected' }, { status: 400 })
    }
    if (url.endsWith('/cache/regions')) return Response.json({ regions: {} })
    throw new Error(`unexpected fetch ${url}`)
  })
  const app = fakeApp()
  let readinessHandler: ((req: unknown, res: { status: (code: number) => unknown, setHeader: (name: string, value: string) => void, end: () => void }) => void) | undefined
  const plugin = createPlugin(app as never, {
    hostHealthMonitorIntervalMs: 5,
    hostHealthFailureThreshold: 1,
    hostHealthRecoveryCooldownMs: 60_000
  })
  plugin.registerWithRouter?.({
    get (path: string, handler: typeof readinessHandler) {
      if (path === '/tiles/ready') readinessHandler = handler
    },
    post () {},
    delete () {}
  } as never)

  await plugin.start({}, () => {})
  try {
    await waitUntil(() => configPushes >= 2)
    await waitUntil(() => app.status.some((message) => message.includes('automatic host-side recovery failed')))
    let status = 0
    readinessHandler?.({ url: '/tiles/ready', headers: {}, on () {} }, {
      status (code) { status = code; return this },
      setHeader () {},
      end () {}
    })

    assert.equal(configPushes, 2)
    assert.equal(status, 503)
    assert.ok(app.status.some((message) => message.includes('automatic host-side recovery failed')))
  } finally {
    await plugin.stop()
  }
})

test('a pending timed-out recovery recreation suppresses duplicate recreations', async (t) => {
  const record = managerRecord()
  const manager = fakeManager({ record, address: '127.0.0.1:31001' })
  manager.recreate = async (name, config) => {
    record.recreated.push({ name, config })
    await new Promise<void>(() => {})
  }
  setContainerManager(manager)
  let healthCalls = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/health')) {
      healthCalls++
      return healthCalls <= 2
        ? Response.json({ status: 'ok', configured: true })
        : Response.json({}, { status: 503 })
    }
    if (url.endsWith('/config')) return new Response(null, { status: 204 })
    if (url.endsWith('/cache/regions')) return Response.json({ regions: {} })
    throw new Error(`unexpected fetch ${url}`)
  })
  const plugin = createPlugin(fakeApp() as never, {
    managerOperationTimeoutMs: 10,
    hostHealthMonitorIntervalMs: 5,
    hostHealthFailureThreshold: 1,
    hostHealthRecoveryCooldownMs: 0
  })

  await plugin.start({}, () => {})
  try {
    await waitUntil(() => record.recreated.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(record.recreated.length, 1)
  } finally {
    await plugin.stop()
  }
})

test('schema includes the reverse-geocoding egress control enabled by default', () => {
  const plugin = createPlugin(fakeApp() as never)
  const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
  const advanced = (schema as { properties: { advanced: { properties: Record<string, { default?: unknown }> } } }).properties.advanced.properties
  assert.equal(advanced.geocodingEnabled?.default, true)
})

test('schema leaves imageTag blank so the runtime fallback advances with the plugin version', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record, address: null }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
  const advanced = (schema as { properties: { advanced: { properties: Record<string, { default?: unknown }> } } }).properties.advanced.properties
  assert.equal(advanced.imageTag?.default, '')
  await plugin.start({ advanced: { imageTag: '' } }, () => {})
  assert.equal(record.ensured[0]?.config.tag, DEFAULT_TILECACHE_TAG)
  await plugin.stop()
})

test('repeated start cleans up the previous position subscription before replacing it', async () => {
  setContainerManager(fakeManager({ address: null }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(app.positionUnsubCalls, 0)
  await plugin.start({}, () => {})
  assert.equal(app.positionUnsubCalls, 1)
  await plugin.stop()
  assert.equal(app.positionUnsubCalls, 2)
})

test('route reconciliation starts whether router registration happens before or after plugin start', async () => {
  for (const registerFirst of [true, false]) {
    const app = fakeApp()
    let starts = 0
    let stops = 0
    const plugin = createPlugin(app as never, {
      registerRegionsRoutes: (() => ({
        start () { starts++ },
        async stop () { stops++ }
      })) as never
    })
    const router = { get () {}, post () {}, delete () {} } as never
    if (registerFirst) plugin.registerWithRouter?.(router)
    await plugin.start({}, () => {})
    if (!registerFirst) plugin.registerWithRouter?.(router)
    assert.equal(starts, 1)
    await plugin.stop()
    assert.equal(stops, 1)
  }
})

test('admin recovery routes retain the container address when configuration fails while public tiles stay unavailable', async (t) => {
  setContainerManager(fakeManager({ address: '127.0.0.1:8080' }))
  const app = fakeApp()
  let adminAddress: (() => string | null) | undefined
  let readinessHandler: ((req: unknown, res: { status: (code: number) => unknown, setHeader: (name: string, value: string) => void, end: () => void }) => void) | undefined
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/health')) return Response.json({ status: 'ok' })
    if (url.endsWith('/config')) return Response.json({ error: 'pinned bytes exceed cap' }, { status: 400 })
    if (url.endsWith('/cache/regions')) return Response.json({ regions: {} })
    throw new Error(`unexpected fetch ${url}`)
  })
  const plugin = createPlugin(app as never, {
    registerRegionsRoutes: ((_router: unknown, _app: unknown, getAddress: () => string | null) => {
      adminAddress = getAddress
      return { start () {}, async stop () {} }
    }) as never
  })
  plugin.registerWithRouter?.({
    get (path: string, handler: typeof readinessHandler) {
      if (path === '/tiles/ready') readinessHandler = handler
    },
    post () {},
    delete () {}
  } as never)
  await plugin.start({}, () => {})
  try {
    assert.equal(adminAddress?.(), '127.0.0.1:8080')
    let status = 0
    readinessHandler?.({ url: '/tiles/ready', headers: {}, on () {} }, {
      status (code) { status = code; return this },
      setHeader () {},
      end () {}
    })
    assert.equal(status, 503)
  } finally {
    await plugin.stop()
  }
})

test('teardown remains best effort when discovery and region cleanup reject', async () => {
  const app = fakeApp()
  let discoveryStops = 0
  let regionStops = 0
  const plugin = createPlugin(app as never, {
    startDiscovery: (async () => ({
      async rescan () {},
      async stop () { discoveryStops++; throw new Error('discovery stop failed') }
    })) as never,
    registerRegionsRoutes: (() => ({
      start () {},
      async stop () { regionStops++; throw new Error('regions stop failed') }
    })) as never
  })
  plugin.registerWithRouter?.({ get () {}, post () {}, delete () {} } as never)
  await plugin.start({}, () => {})
  await assert.doesNotReject(async () => { await plugin.stop() })
  assert.equal(discoveryStops, 1)
  assert.equal(regionStops, 1)
})

test('a never-settling container launch is bounded and a later completion is stopped', async () => {
  const record = managerRecord()
  const manager = fakeManager({ record, address: null })
  let completeLaunch!: () => void
  manager.ensureRunning = (name, config) => {
    record.ensured.push({ name, config })
    return new Promise<void>((resolve) => { completeLaunch = resolve })
  }
  setContainerManager(manager)
  const app = fakeApp()
  const plugin = createPlugin(app as never, { managerOperationTimeoutMs: 10 })

  await plugin.start({}, () => {})
  assert.equal(record.stopped.length, 0)
  completeLaunch()
  const deadline = Date.now() + 1000
  while (record.stopped.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(record.stopped, [TILECACHE_CONTAINER_NAME])
  await plugin.stop()
})

test('address resolution and teardown manager calls are independently bounded', async () => {
  {
    const record = managerRecord()
    const manager = fakeManager({ record })
    manager.resolveContainerAddress = async () => await new Promise<string | null>(() => {})
    setContainerManager(manager)
    const plugin = createPlugin(fakeApp() as never, { managerOperationTimeoutMs: 10 })
    await plugin.start({}, () => {})
    await plugin.stop()
    assert.deepEqual(record.stopped, [TILECACHE_CONTAINER_NAME])
  }

  {
    const record = managerRecord()
    const manager = fakeManager({ record, address: null })
    manager.stop = async (name) => {
      record.stopped.push(name)
      await new Promise<void>(() => {})
    }
    setContainerManager(manager)
    const plugin = createPlugin(fakeApp() as never, { managerOperationTimeoutMs: 10 })
    await plugin.start({}, () => {})
    const started = Date.now()
    await plugin.stop()
    assert.ok(Date.now() - started < 1000)
    assert.deepEqual(record.stopped, [TILECACHE_CONTAINER_NAME])
  }
})

test('a pending late cleanup suppresses a newer launch of the fixed container name', async () => {
  const record = managerRecord()
  const manager = fakeManager({ record, address: null })
  manager.ensureRunning = (name, config) => {
    record.ensured.push({ name, config })
    return new Promise<void>(() => {})
  }
  setContainerManager(manager)
  const app = fakeApp()
  const plugin = createPlugin(app as never, { managerOperationTimeoutMs: 10 })
  await plugin.start({}, () => {})
  await plugin.start({}, () => {})
  assert.equal(record.ensured.length, 1)
  await plugin.stop()
})
