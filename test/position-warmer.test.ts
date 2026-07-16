import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LngLatBbox } from 'signalk-chart-sources'
import { createPositionWarmer } from '../src/runtime/position-warmer.js'
import { DEFAULT_REGIONS_STORE } from '../src/runtime/regions-store.js'
import type { RegionsStore, SavedRegion } from '../src/runtime/regions-store.js'

function region (bbox: LngLatBbox): SavedRegion {
  return { id: 'r1', name: 'Test', bbox, sourceIds: [], minzoom: 6, maxzoom: 12, createdAt: 0, lastDownloadedAt: null, bytes: 0, status: 'ready' }
}

function store (over: Partial<typeof DEFAULT_REGIONS_STORE.positionWarm> = {}): RegionsStore {
  return {
    regions: [region([-123, 37, -122, 38])],
    positionWarm: { ...DEFAULT_REGIONS_STORE.positionWarm, enabled: true, sources: ['seamark'], ...over },
    cacheScrollTtlDays: 30
  }
}

test('warms once outside the box, then respects the interval', async () => {
  let clock = 1_000_000
  const warmed: LngLatBbox[] = []
  const warmer = createPositionWarmer({
    getStore: () => store(),
    warm: async (bbox) => { warmed.push(bbox); return { state: 'done', errors: 0, total: 4 } },
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
  const warmer = createPositionWarmer({ getStore: () => store(), warm: async (b) => { warmed.push(b); return { state: 'done', errors: 0, total: 1 } }, now: () => 1_000_000 })
  warmer.onPosition({ latitude: 37.5, longitude: -122.5 }) // inside
  await Promise.resolve()
  assert.equal(warmed.length, 0)
})

test('backs off after an all-errors warm', async () => {
  let clock = 1_000_000
  let calls = 0
  const warmer = createPositionWarmer({
    getStore: () => store(),
    warm: async () => { calls++; return { state: 'done', errors: 16, total: 16 } }, // all errors: offline
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

test('passes both antimeridian boxes in one warm job', async () => {
  let additional: LngLatBbox | undefined
  const warmer = createPositionWarmer({
    getStore: () => store({ radiusMeters: 5000 }),
    warm: async (_bbox, _sources, _minzoom, _maxzoom, _regionId, additionalBbox) => {
      additional = additionalBbox
      return { state: 'done', errors: 0, total: 2 }
    },
    now: () => 1_000_000
  })
  warmer.onPosition({ latitude: 0, longitude: 179.99 })
  await Promise.resolve()
  assert.ok(additional)
  assert.equal(additional[0], -180)
})

test('clamps the derived zoom window to the container maximum', async () => {
  let zooms: [number, number] | undefined
  const warmer = createPositionWarmer({
    getStore: () => store({ baseZoom: 24 }),
    warm: async (_bbox, _sources, minzoom, maxzoom) => {
      zooms = [minzoom, maxzoom]
      return { state: 'done', errors: 0, total: 1 }
    }
  })
  warmer.onPosition({ latitude: 37.5, longitude: -121.5 })
  await Promise.resolve()
  assert.deepEqual(zooms, [23, 24])
})

test('does nothing when no position-warm sources are selected', async () => {
  let calls = 0
  const warmer = createPositionWarmer({
    getStore: () => store({ sources: [] }),
    warm: async () => { calls++; return { state: 'done', errors: 0, total: 0 } }
  })
  warmer.onPosition({ latitude: 37.5, longitude: -121.5 })
  await Promise.resolve()
  assert.equal(calls, 0)
})

test('retries a failed warm after backoff even when the vessel has not moved', async () => {
  let clock = 1_000_000
  let calls = 0
  const warmer = createPositionWarmer({
    getStore: () => store(),
    warm: async () => { calls++; return calls === 1 ? null : { state: 'done', errors: 0, total: 1 } },
    now: () => clock,
    backoffSecs: 60
  })
  const position = { latitude: 37.5, longitude: -121.5 }
  warmer.onPosition(position)
  await Promise.resolve()
  clock += 61_000
  warmer.onPosition(position)
  await Promise.resolve()
  assert.equal(calls, 2)
})

test('ignores malformed and out-of-world positions', async () => {
  let calls = 0
  const warmer = createPositionWarmer({
    getStore: () => store(),
    warm: async () => { calls++; return { state: 'done', errors: 0, total: 1 } }
  })
  for (const position of [null, { latitude: Number.NaN, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 181 }]) {
    warmer.onPosition(position as never)
  }
  await Promise.resolve()
  assert.equal(calls, 0)
})

test('backs off after every non-success terminal state even with zero errors', async () => {
  for (const state of ['capped', 'cancelled', 'error'] as const) {
    let clock = 1_000_000
    let calls = 0
    const warmer = createPositionWarmer({
      getStore: () => store(),
      warm: async () => { calls++; return { state, errors: 0, total: 1 } },
      now: () => clock,
      backoffSecs: 600
    })
    warmer.onPosition({ latitude: 37.5, longitude: -121.5 })
    await Promise.resolve()
    clock += 120_000
    warmer.onPosition({ latitude: 38.5, longitude: -120.5 })
    await Promise.resolve()
    assert.equal(calls, 1, `${state} must activate backoff`)
  }
})

test('stop aborts and drains an in-flight warm and ignores later positions', async () => {
  let calls = 0
  let started: (() => void) | undefined
  const warmStarted = new Promise<void>((resolve) => { started = resolve })
  const warmer = createPositionWarmer({
    getStore: () => store(),
    warm: async (_bbox, _sources, _minzoom, _maxzoom, _regionId, _additional, signal) => {
      calls++
      started?.()
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
  })
  warmer.onPosition({ latitude: 37.5, longitude: -121.5 })
  await warmStarted
  await warmer.stop()
  warmer.onPosition({ latitude: 38.5, longitude: -120.5 })
  await Promise.resolve()
  assert.equal(calls, 1)
})

test('a regions-store read failure does not escape the position callback and enters backoff', () => {
  let calls = 0
  const errors: unknown[] = []
  const warmer = createPositionWarmer({
    getStore: () => { calls++; throw new Error('state unavailable') },
    warm: async () => null,
    now: () => 1_000_000,
    backoffSecs: 60,
    onError: (error) => { errors.push(error) }
  })
  assert.doesNotThrow(() => { warmer.onPosition({ latitude: 1, longitude: 1 }) })
  warmer.onPosition({ latitude: 2, longitude: 2 })
  assert.equal(calls, 1)
  assert.equal(errors.length, 1)
})

test('a synchronous warm throw leaves task bookkeeping drainable', async () => {
  let calls = 0
  const errors: unknown[] = []
  const warmer = createPositionWarmer({
    getStore: () => store(),
    warm: (() => { calls++; throw new Error('synchronous failure') }) as never,
    backoffSecs: 0,
    onError: (error) => { errors.push(error) }
  })
  warmer.onPosition({ latitude: 37.5, longitude: -121.5 })
  await Promise.resolve()
  warmer.onPosition({ latitude: 38.5, longitude: -120.5 })
  await Promise.resolve()
  await warmer.stop()
  assert.equal(calls, 2)
  assert.equal(errors.length, 2)
})
