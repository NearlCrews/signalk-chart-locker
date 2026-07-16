import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LngLatBbox } from 'signalk-chart-sources'
import { insideBox, haversineMeters, bboxAround, bboxesAround, shouldWarm, insideAnyRegion, type WarmTrigger } from '../src/runtime/position-warm.js'
import { DEFAULT_REGIONS_STORE } from '../src/runtime/regions-store.js'
import type { SavedRegion } from '../src/runtime/regions-store.js'

const here = { latitude: 37.8, longitude: -122.4 }
const settings = { ...DEFAULT_REGIONS_STORE.positionWarm, enabled: true, sources: ['seamark'] }
const fresh: WarmTrigger = { lastPos: null, lastWarmMs: 0, backoffUntilMs: 0 }

function region (bbox: LngLatBbox): SavedRegion {
  return { id: 'r1', name: 'Test', bbox, sourceIds: [], minzoom: 6, maxzoom: 12, createdAt: 0, lastDownloadedAt: null, bytes: 0, status: 'ready' }
}

test('insideBox is true only within the box', () => {
  assert.equal(insideBox(here, [-123, 37, -122, 38]), true)
  assert.equal(insideBox(here, [-122, 37, -121, 38]), false)
  assert.equal(insideBox(here, null), false)
})

test('insideBox recognizes both sides of an antimeridian-crossing box', () => {
  const crossing: LngLatBbox = [170, -10, -170, 10]
  assert.equal(insideBox({ latitude: 0, longitude: 175 }, crossing), true)
  assert.equal(insideBox({ latitude: 0, longitude: -175 }, crossing), true)
  assert.equal(insideBox({ latitude: 0, longitude: 0 }, crossing), false)
})

test('haversine is roughly a nautical mile for a minute of latitude', () => {
  const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1 / 60, longitude: 0 })
  assert.ok(Math.abs(d - 1852) < 5)
})

test('bboxAround brackets the position', () => {
  const radiusMeters = 1852
  const [minLng, minLat, maxLng, maxLat] = bboxAround(here, radiusMeters)
  assert.ok(minLng < here.longitude && maxLng > here.longitude)
  assert.ok(minLat < here.latitude && maxLat > here.latitude)
  assert.ok(haversineMeters(here, { latitude: minLat, longitude: here.longitude }) >= radiusMeters * 0.95)
})

test('bboxesAround splits a radius crossing the antimeridian', () => {
  const boxes = bboxesAround({ latitude: 0, longitude: 179.99 }, 5000)
  assert.equal(boxes.length, 2)
  assert.equal(boxes[0]![2], 180)
  assert.equal(boxes[1]![0], -180)
  assert.ok(boxes[1]![2] > -180)
})

test('shouldWarm fires outside the box after the move threshold and interval', () => {
  // first fix, outside the box, no prior warm: fires.
  assert.equal(shouldWarm(here, [region([-122, 37, -121, 38])], settings, fresh, 1_000_000), true)
})

test('shouldWarm is false inside the box', () => {
  assert.equal(shouldWarm(here, [region([-123, 37, -122, 38])], settings, fresh, 1_000_000), false)
})

test('shouldWarm respects the interval and the move threshold', () => {
  const recent: WarmTrigger = { lastPos: here, lastWarmMs: 1_000_000, backoffUntilMs: 0 }
  // same spot, 30 s later: under the 60 s interval, no warm.
  assert.equal(shouldWarm(here, [region([-122, 37, -121, 38])], settings, recent, 1_030_000), false)
  // 90 s later but barely moved: under the move threshold, no warm.
  assert.equal(shouldWarm({ latitude: 37.8001, longitude: -122.4 }, [region([-122, 37, -121, 38])], settings, recent, 1_090_000), false)
})

test('shouldWarm floors the interval at 60 s even if the settings ask for less', () => {
  const recent: WarmTrigger = { lastPos: { latitude: 30, longitude: -120 }, lastWarmMs: 1_000_000, backoffUntilMs: 0 }
  const fast = { ...settings, intervalSecs: 5 }
  // 10 s later, well moved, but under the 60 s floor: no warm.
  assert.equal(shouldWarm(here, [region([-122, 37, -121, 38])], fast, recent, 1_010_000), false)
  // 61 s later, well moved: fires.
  assert.equal(shouldWarm(here, [region([-122, 37, -121, 38])], fast, recent, 1_061_000), true)
})

test('shouldWarm backs off after an all-errors warm', () => {
  const backed: WarmTrigger = { lastPos: null, lastWarmMs: 0, backoffUntilMs: 2_000_000 }
  assert.equal(shouldWarm(here, [region([-122, 37, -121, 38])], settings, backed, 1_500_000), false)
  assert.equal(shouldWarm(here, [region([-122, 37, -121, 38])], settings, backed, 2_500_000), true)
})

test('shouldWarm is false when disabled', () => {
  assert.equal(shouldWarm(here, [region([-122, 37, -121, 38])], { ...settings, enabled: false }, fresh, 1_000_000), false)
})

test('insideAnyRegion is true only when inside at least one region bbox', () => {
  const pos = { latitude: 37.8, longitude: -122.4 }
  assert.equal(insideAnyRegion(pos, [region([-123, 37, -122, 38])]), true)
  assert.equal(insideAnyRegion(pos, [region([0, 0, 1, 1])]), false)
  assert.equal(insideAnyRegion(pos, [region([0, 0, 1, 1]), region([-123, 37, -122, 38])]), true)
  assert.equal(insideAnyRegion(pos, []), false)
})

test('shouldWarm with a regions list fires outside all regions on the first fix', () => {
  const pos = { latitude: 0.5, longitude: 0.5 }
  const regions = [region([-123, 37, -122, 38])]
  assert.equal(shouldWarm(pos, regions, settings, fresh, 1_000_000), true)
})

test('shouldWarm with a regions list is false when inside any region', () => {
  const pos = { latitude: 37.8, longitude: -122.4 }
  const regions = [region([-123, 37, -122, 38])]
  assert.equal(shouldWarm(pos, regions, settings, fresh, 1_000_000), false)
})

test('only ready and actively downloading regions suppress automatic warming', () => {
  const bbox: LngLatBbox = [-123, 37, -122, 38]
  for (const status of ['ready', 'downloading'] as const) {
    assert.equal(shouldWarm(here, [{ ...region(bbox), status }], settings, fresh, 1_000_000), false, status)
  }
  for (const status of ['capped', 'error', 'needs-redownload'] as const) {
    assert.equal(shouldWarm(here, [{ ...region(bbox), status }], settings, fresh, 1_000_000), true, status)
  }
})

test('shouldWarm with an empty regions list fires on the first fix (migrated null bbox)', () => {
  const pos = { latitude: 0.5, longitude: 0.5 }
  assert.equal(shouldWarm(pos, [], settings, fresh, 1_000_000), true)
})
