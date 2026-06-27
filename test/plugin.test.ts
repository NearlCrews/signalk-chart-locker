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

test('a failed container launch surfaces a plugin error instead of an unhandled rejection', async () => {
  // Signal K does not await start(), so a rejection here must be caught inside the plugin. The
  // returned promise must resolve (not reject) and the failure must land as a plugin error.
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning () { throw new Error('runtime refused the container') },
    async resolveContainerAddress () { return null },
    async stop () {}
  }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = manager
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(() => Promise.resolve(plugin.start({}, () => {})))
  assert.equal(app.errors.length, 1)
  assert.match(app.errors[0], /runtime refused the container/)
  assert.equal(getRouteOnWaterBridge(), undefined)
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

test('stop with no prior start and a manager present is a clean no-op', async () => {
  const record = { ensured: [] as Array<{ name: string; config: ContainerConfig }>, stopped: [] as string[] }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = fakeManager(record)
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(async () => { await plugin.stop() })
  assert.deepEqual(record.stopped, [])
})

test('partial failure: launched container is stopped even when address resolution fails', async () => {
  // ensureRunning resolves (container is now running) but resolveContainerAddress returns null,
  // causing startCompanion to throw. A subsequent stop() must still stop the container.
  const record = { ensured: [] as Array<{ name: string; config: ContainerConfig }>, stopped: [] as string[] }
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (name, config) { record.ensured.push({ name, config }) },
    async resolveContainerAddress () { return null },
    async stop (name) { record.stopped.push(name) }
  }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = manager
  const app = fakeApp()
  const plugin = createPlugin(app as never)

  // start() always resolves (error is caught inside); the plugin error is set internally.
  await plugin.start({}, () => {})
  assert.equal(app.errors.length, 1)
  assert.equal(getRouteOnWaterBridge(), undefined)

  await plugin.stop()
  assert.deepEqual(record.stopped, [ROUTER_CONTAINER_NAME])
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('stop-during-in-flight-start: no bridge is installed and the container is stopped', async () => {
  // resolveContainerAddress blocks until releaseAddress fires. We wait for ensureRunning to complete
  // (so launched === true) before calling stop(), ensuring a genuine mid-launch race.
  let releaseAddress!: (addr: string) => void
  const addressDeferred = new Promise<string>(resolve => { releaseAddress = resolve })
  let signalEnsured!: () => void
  const ensuredBarrier = new Promise<void>(resolve => { signalEnsured = resolve })

  const record = { ensured: [] as Array<{ name: string; config: ContainerConfig }>, stopped: [] as string[] }
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (name, config) { record.ensured.push({ name, config }); signalEnsured() },
    resolveContainerAddress () { return addressDeferred },
    async stop (name) { record.stopped.push(name) }
  }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = manager
  const app = fakeApp()
  const plugin = createPlugin(app as never)

  const startResult = plugin.start({}, () => {})
  await ensuredBarrier            // start is now parked at resolveContainerAddress, launched === true
  const stopResult = plugin.stop()
  releaseAddress('127.0.0.1:8080')
  await Promise.all([startResult, stopResult])

  assert.equal(getRouteOnWaterBridge(), undefined)
  assert.ok(record.stopped.includes(ROUTER_CONTAINER_NAME))
})

test('stop then start again installs the bridge on the second start', async () => {
  const record = { ensured: [] as Array<{ name: string; config: ContainerConfig }>, stopped: [] as string[] }
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = fakeManager(record)
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  await plugin.stop()
  await plugin.start({}, () => {})
  assert.ok(getRouteOnWaterBridge() !== undefined)
  assert.equal(record.ensured.length, 2)
})
