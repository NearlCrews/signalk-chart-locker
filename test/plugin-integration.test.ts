import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Plugin } from '@signalk/server-api'
import { createPlugin } from '../src/plugin/plugin.js'
import { getRouteOnWaterBridge } from '../src/bridge/route-on-water-bridge.js'
import { fakeApp, fakeManager, managerRecord, setContainerManager, clearGlobals } from './helpers.js'

// The end-to-end cutover slice: drive the real plugin start path (the real createRouterBridge
// over the real fetch) through a fake container manager, then call the published global bridge
// exactly as the crows-nest in-process caller will. The container is stood up as a local HTTP
// stub for the reachable case and a fixed refused address for the down case, so the fallback
// signal is proven without a real container.

const CANNED_ROUTE = {
  ok: true,
  waypoints: [
    { latitude: 37.80, longitude: -122.42 },
    { latitude: 37.79, longitude: -122.39 }
  ],
  usedTileWater: false,
  borderFallback: false
}

const SAMPLE_REQUEST = {
  from: { latitude: 37.80, longitude: -122.42 },
  to: { latitude: 37.79, longitude: -122.39 },
  draftMeters: 2.0,
  safetyMarginMeters: 0.5,
  standoffNm: 0.02,
  borderAware: false
}

// Port 1 has no listener in any test environment, so a connect to it is refused immediately. This
// is deterministic and free of the port-reuse race a just-freed ephemeral port would carry.
const DEAD_ADDRESS = '127.0.0.1:1'

/** A local stand-in for the router container: answers /health and /route-on-water like the real one. */
async function startRouterStub (): Promise<{ address: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method === 'POST' && req.url === '/route-on-water') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(CANNED_ROUTE))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    address: `127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => { server.close(err => { if (err) reject(err); else resolve() }) })
  }
}

let activePlugin: Plugin | undefined

test.afterEach(async () => {
  // Tear the lifecycle down symmetrically before clearing the globals it reads, so no test leaks
  // a started plugin into the next.
  if (activePlugin) await activePlugin.stop()
  activePlugin = undefined
  clearGlobals()
})

test('end-to-end: a started plugin publishes a bridge that routes through the reachable container', async () => {
  const stub = await startRouterStub()
  try {
    setContainerManager(fakeManager({ address: stub.address }))
    const app = fakeApp()
    activePlugin = createPlugin(app as never)
    await activePlugin.start({}, () => {})

    const bridge = getRouteOnWaterBridge()
    assert.ok(bridge, 'the bridge is installed after start')
    await bridge.whenReady() // probes /health end-to-end through the real fetch
    const result = await bridge.routeOnWater(SAMPLE_REQUEST)
    assert.deepEqual(result, CANNED_ROUTE)
    assert.equal(app.errors.length, 0)
  } finally {
    await stub.close()
  }
})

test('end-to-end: the published bridge returns router-unavailable when the container is down', async () => {
  setContainerManager(fakeManager({ address: DEAD_ADDRESS }))
  const app = fakeApp()
  activePlugin = createPlugin(app as never)
  await activePlugin.start({}, () => {})

  // start does not probe the container, so it succeeds and installs the bridge over the dead
  // address. The failure surfaces only when the caller routes, as the fallback decline.
  assert.equal(app.errors.length, 0)
  const bridge = getRouteOnWaterBridge()
  assert.ok(bridge, 'the bridge is installed even though the container is unreachable')
  const result = await bridge.routeOnWater(SAMPLE_REQUEST)
  assert.deepEqual(result, { ok: false, reason: 'router-unavailable' })
})

test('end-to-end: no detected runtime short-circuits start, so no container is ensured and no bridge is published', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ runtime: null, record }))
  const app = fakeApp()
  activePlugin = createPlugin(app as never)
  await activePlugin.start({}, () => {})

  assert.deepEqual(record.ensured, [])
  assert.equal(getRouteOnWaterBridge(), undefined)
  assert.equal(app.errors.length, 1)
})
