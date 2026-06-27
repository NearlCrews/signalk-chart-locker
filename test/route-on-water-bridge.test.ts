import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_GLOBAL_KEY,
  installRouteOnWaterBridge,
  removeRouteOnWaterBridge,
  getRouteOnWaterBridge,
  createSkeletonBridge
} from '../src/bridge/route-on-water-bridge.js'

test.afterEach(() => {
  removeRouteOnWaterBridge()
})

test('install publishes the bridge on the global key and remove clears it', () => {
  const bridge = createSkeletonBridge('127.0.0.1:8080', async () => true)
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

test('the skeleton bridge reports not-implemented when the container is healthy', async () => {
  const bridge = createSkeletonBridge('127.0.0.1:8080', async () => true)
  const result = await bridge.routeOnWater({})
  assert.deepEqual(result, { ok: false, reason: 'not-implemented' })
})

test('the skeleton bridge reports router-unavailable when the container is unhealthy', async () => {
  const bridge = createSkeletonBridge('127.0.0.1:8080', async () => false)
  const result = await bridge.routeOnWater({})
  assert.deepEqual(result, { ok: false, reason: 'router-unavailable' })
})
