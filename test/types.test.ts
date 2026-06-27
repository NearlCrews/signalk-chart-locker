import test from 'node:test'
import assert from 'node:assert/strict'
import type { RouteOnWaterResult } from '../src/shared/types.js'

// A compile-time and runtime check that the discriminated union narrows on `ok`.
test('a successful result carries waypoints and flags', () => {
  const result: RouteOnWaterResult = {
    ok: true,
    waypoints: [{ latitude: 1, longitude: 2 }],
    usedTileWater: false,
    borderFallback: false
  }
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.waypoints.length, 1)
    assert.equal(result.usedTileWater, false)
  }
})

test('a failed result carries a reason', () => {
  const result: RouteOnWaterResult = { ok: false, reason: 'router-unavailable' }
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'router-unavailable')
  }
})
