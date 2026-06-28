import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerManager } from '../src/shared/types.js'
import { createPlugin } from '../src/plugin/plugin.js'
import { getRouteOnWaterBridge } from '../src/bridge/route-on-water-bridge.js'
import { ROUTER_CONTAINER_NAME } from '../src/runtime/router-container.js'
import { PLUGIN_ID, PLUGIN_NAME } from '../src/shared/plugin-id.js'
import { fakeApp, fakeManager, managerRecord, setContainerManager, clearGlobals } from './helpers.js'

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

test('start sets a plugin error and does nothing when the container manager is missing', async () => {
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(app.errors.length, 1)
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('start launches the container and installs the bridge when the runtime is ready', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(record.ensured.filter((e) => e.name === ROUTER_CONTAINER_NAME).length, 1)
  assert.equal(record.ensured[0].name, ROUTER_CONTAINER_NAME)
  assert.ok(getRouteOnWaterBridge() !== undefined)
  // Starting plus the running status, in that order.
  assert.equal(app.status.length, 2)
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
  setContainerManager(manager)
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(() => Promise.resolve(plugin.start({}, () => {})))
  assert.equal(app.errors.length, 1)
  assert.match(app.errors[0], /runtime refused the container/)
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('stop removes the bridge and stops the container', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  await plugin.stop()
  assert.equal(getRouteOnWaterBridge(), undefined)
  assert.deepEqual(record.stopped.filter((n) => n === ROUTER_CONTAINER_NAME), [ROUTER_CONTAINER_NAME])
})

test('stop with no prior start and a manager present is a clean no-op', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(async () => { await plugin.stop() })
  assert.deepEqual(record.stopped, [])
})

test('partial failure: launched container is stopped even when address resolution fails', async () => {
  // ensureRunning resolves (container is now running) but resolveContainerAddress returns null,
  // causing startCompanion to throw. A subsequent stop() must still stop the container.
  const record = managerRecord()
  setContainerManager(fakeManager({ address: null, record }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)

  // start() always resolves (error is caught inside); the plugin error is set internally.
  await plugin.start({}, () => {})
  assert.equal(app.errors.length, 1)
  assert.equal(getRouteOnWaterBridge(), undefined)

  await plugin.stop()
  assert.deepEqual(record.stopped.filter((n) => n === ROUTER_CONTAINER_NAME), [ROUTER_CONTAINER_NAME])
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('stop-during-in-flight-start: no bridge is installed and the container is stopped', async () => {
  // resolveContainerAddress blocks until releaseAddress fires. We wait for ensureRunning to complete
  // (so launched === true) before calling stop(), ensuring a genuine mid-launch race.
  let releaseAddress!: (addr: string) => void
  const addressDeferred = new Promise<string>(resolve => { releaseAddress = resolve })
  let signalEnsured!: () => void
  const ensuredBarrier = new Promise<void>(resolve => { signalEnsured = resolve })

  const record = managerRecord()
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (name, config) { record.ensured.push({ name, config }); signalEnsured() },
    resolveContainerAddress () { return addressDeferred },
    async stop (name) { record.stopped.push(name) }
  }
  setContainerManager(manager)
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

test('lifecycle serialization: stop-during-start and start-during-stop run in order, no transitions lost or orphaned', async () => {
  // Under the old flag-based implementation, calling start() while stop() was awaiting an in-flight
  // start would reset stopRequested, causing the in-flight start to miss the stop signal and
  // potentially leaving the bridge or container orphaned. This test proves serialization eliminates
  // that race: all three transitions (start1, stop, start2) execute in submission order with no
  // transition skipped and no orphan produced.
  let releaseEnsure!: () => void
  const ensureBlocker = new Promise<void>(resolve => { releaseEnsure = resolve })
  let signalFirstEnsure!: () => void
  const firstEnsureBarrier = new Promise<void>(resolve => { signalFirstEnsure = resolve })
  let ensureCallCount = 0

  const record = managerRecord()
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (name, config) {
      record.ensured.push({ name, config })
      if (++ensureCallCount === 1) { signalFirstEnsure(); await ensureBlocker }
    },
    async resolveContainerAddress () { return '127.0.0.1:8080' },
    async stop (name) { record.stopped.push(name) }
  }
  setContainerManager(manager)
  const app = fakeApp()
  const plugin = createPlugin(app as never)

  // Queue three transitions while start1 is blocked mid-launch.
  // stop() tests stop-during-start; start2() tests start-during-stop (stop was called but has not
  // started executing, so from the caller's perspective stop is still in flight when start2 is queued).
  const p1 = plugin.start({}, () => {})
  await firstEnsureBarrier      // start1 is parked inside its first ensureRunning call
  const p2 = plugin.stop()      // queued: will run after start1 completes
  const p3 = plugin.start({}, () => {}) // queued: will run after stop completes
  releaseEnsure()
  await Promise.all([p1, p2, p3])

  // All three transitions ran in submission order: start1, stop, start2.
  // Bridge is installed by start2 (net intent: started). Container was ensured twice, stopped once.
  // No orphaned bridge or container exists from the first start-stop pair.
  assert.ok(getRouteOnWaterBridge() !== undefined, 'bridge installed by start2, the last transition')
  assert.equal(record.ensured.filter((e) => e.name === ROUTER_CONTAINER_NAME).length, 2, 'both start transitions ensured the router')
  assert.deepEqual(record.stopped.filter((n) => n === ROUTER_CONTAINER_NAME), [ROUTER_CONTAINER_NAME], 'router stopped exactly once between the two starts')
  assert.equal(app.errors.length, 0, 'no errors from any transition')
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

test('stop then start again installs the bridge on the second start', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  await plugin.stop()
  await plugin.start({}, () => {})
  assert.ok(getRouteOnWaterBridge() !== undefined)
  assert.equal(record.ensured.filter((e) => e.name === ROUTER_CONTAINER_NAME).length, 2)
})
