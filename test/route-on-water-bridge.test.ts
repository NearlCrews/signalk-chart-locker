import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_GLOBAL_KEY,
  installRouteOnWaterBridge,
  removeRouteOnWaterBridge,
  getRouteOnWaterBridge,
  createRouterBridge,
  type PostFetch
} from '../src/bridge/route-on-water-bridge.js'

const BRIDGE_ADDRESS = '127.0.0.1:8080'
const HEALTHY_PROBE = async () => true

test.afterEach(() => {
  removeRouteOnWaterBridge()
})

test('install publishes the bridge on the global key and remove clears it', () => {
  const bridge = createRouterBridge(BRIDGE_ADDRESS, HEALTHY_PROBE)
  installRouteOnWaterBridge(bridge)
  assert.equal((globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY], bridge)
  assert.equal(getRouteOnWaterBridge(), bridge)
  removeRouteOnWaterBridge()
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('remove is safe to call when nothing is installed', () => {
  removeRouteOnWaterBridge()
  assert.equal(getRouteOnWaterBridge(), undefined)
})

test('routeOnWater posts the request to the container and returns the parsed result', async () => {
  let capturedUrl: string | undefined
  let capturedInit: Parameters<PostFetch>[1]
  const fetchMock: PostFetch = async (url, init) => {
    capturedUrl = url
    capturedInit = init
    return {
      ok: true,
      json: async () => ({ ok: true, waypoints: [{ latitude: 1, longitude: 2 }], usedTileWater: false, borderFallback: false })
    }
  }
  const bridge = createRouterBridge(BRIDGE_ADDRESS, HEALTHY_PROBE, fetchMock)
  const request = { from: { latitude: 0, longitude: 0 }, to: { latitude: 3, longitude: 4 } }
  const result = await bridge.routeOnWater(request)

  assert.equal(capturedUrl, `http://${BRIDGE_ADDRESS}/route-on-water`)
  assert.ok(capturedInit)
  assert.equal(capturedInit.method, 'POST')
  assert.deepEqual(JSON.parse(capturedInit.body ?? 'null'), request)
  assert.deepEqual(result, { ok: true, waypoints: [{ latitude: 1, longitude: 2 }], usedTileWater: false, borderFallback: false })
})

test('routeOnWater returns router-unavailable when the fetch rejects', async () => {
  const fetchMock: PostFetch = async () => {
    throw new Error('connection refused')
  }
  const bridge = createRouterBridge(BRIDGE_ADDRESS, HEALTHY_PROBE, fetchMock)
  const result = await bridge.routeOnWater({})
  assert.deepEqual(result, { ok: false, reason: 'router-unavailable' })
})

test('routeOnWater returns router-unavailable on a non-ok HTTP response', async () => {
  const fetchMock: PostFetch = async () => ({ ok: false, json: async () => ({}) })
  const bridge = createRouterBridge(BRIDGE_ADDRESS, HEALTHY_PROBE, fetchMock)
  const result = await bridge.routeOnWater({})
  assert.deepEqual(result, { ok: false, reason: 'router-unavailable' })
})

test('routeOnWater passes through an engine decline on an ok HTTP response', async () => {
  const fetchMock: PostFetch = async () => ({ ok: true, json: async () => ({ ok: false, reason: 'no-coverage' }) })
  const bridge = createRouterBridge(BRIDGE_ADDRESS, HEALTHY_PROBE, fetchMock)
  const result = await bridge.routeOnWater({})
  assert.deepEqual(result, { ok: false, reason: 'no-coverage' })
})

test('whenReady resolves when the health probe reports healthy', async () => {
  const bridge = createRouterBridge(BRIDGE_ADDRESS, HEALTHY_PROBE)
  await bridge.whenReady()
  assert.ok(true)
})
