import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPositionWarmer } from '../src/runtime/position-warmer.js'
import { DEFAULT_PREWARM_CONFIG } from '../src/runtime/prewarm-store.js'

function config (over = {}) {
  return { ...DEFAULT_PREWARM_CONFIG, bbox: [-123, 37, -122, 38] as [number, number, number, number], positionWarm: { ...DEFAULT_PREWARM_CONFIG.positionWarm, enabled: true, sources: ['seamark'], ...over } }
}

test('warms once outside the box, then respects the interval', async () => {
  let clock = 1_000_000
  const warmed: Array<[number, number, number, number]> = []
  const warmer = createPositionWarmer({
    getConfig: () => config(),
    warm: async (bbox) => { warmed.push(bbox); return { errors: 0, total: 4 } },
    now: () => clock
  })
  warmer.onPosition({ latitude: 37.5, longitude: -121.5 }) // outside the box
  await Promise.resolve()
  assert.equal(warmed.length, 1)
  clock += 30_000
  warmer.onPosition({ latitude: 37.5, longitude: -121.5 }) // under the interval
  await Promise.resolve()
  assert.equal(warmed.length, 1)
})

test('does not warm inside the box', async () => {
  const warmed: unknown[] = []
  const warmer = createPositionWarmer({ getConfig: () => config(), warm: async (b) => { warmed.push(b); return { errors: 0, total: 1 } }, now: () => 1_000_000 })
  warmer.onPosition({ latitude: 37.5, longitude: -122.5 }) // inside
  await Promise.resolve()
  assert.equal(warmed.length, 0)
})

test('backs off after an all-errors warm', async () => {
  let clock = 1_000_000
  let calls = 0
  const warmer = createPositionWarmer({
    getConfig: () => config(),
    warm: async () => { calls++; return { errors: 16, total: 16 } }, // all errors: offline
    now: () => clock,
    backoffSecs: 600
  })
  warmer.onPosition({ latitude: 37.5, longitude: -121.5 })
  await Promise.resolve()
  assert.equal(calls, 1)
  clock += 120_000 // 2 min later, well past the interval, but inside the 10 min backoff
  warmer.onPosition({ latitude: 38.5, longitude: -120.5 })
  await Promise.resolve()
  assert.equal(calls, 1, 'still backed off')
  clock += 600_000
  warmer.onPosition({ latitude: 39.5, longitude: -119.5 })
  await Promise.resolve()
  assert.equal(calls, 2, 'resumes after the backoff')
})
