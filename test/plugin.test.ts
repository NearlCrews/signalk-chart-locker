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

test('stop does not stop the container when start never succeeded', async () => {
  const record = { ensured: [] as Array<{ name: string; config: ContainerConfig }>, stopped: [] as string[] }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = fakeManager(record)
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.stop()
  assert.deepEqual(record.stopped, [])
})
