import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegionsStore, saveRegionsStore, type RegionsStore } from '../src/runtime/regions-store.js'

function tmp (): string {
  return mkdtempSync(join(tmpdir(), 'regions-store-'))
}

test('a corrupt file falls back to an empty store rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regions-store-'))
  writeFileSync(join(dir, 'regions.json'), 'not json')
  const store = loadRegionsStore(dir)
  assert.deepEqual(store.regions, [])
  assert.equal(store.positionWarm.enabled, false)
})

test('fresh directory returns empty regions list and default position-warm', () => {
  const store = loadRegionsStore(tmp())
  assert.deepEqual(store.regions, [])
  assert.equal(store.positionWarm.enabled, false)
  assert.equal(store.positionWarm.radiusMeters, 3704)
})

test('round-trips a saved region via saveRegionsStore and loadRegionsStore', () => {
  const dir = tmp()
  const region: RegionsStore['regions'][0] = {
    id: 'r1',
    name: 'San Francisco Bay',
    bbox: [-122.5, 37.5, -122.0, 38.0],
    sourceIds: ['depth-gebco', 'seamark'],
    minzoom: 6,
    maxzoom: 12,
    createdAt: 1_700_000_000,
    lastDownloadedAt: null,
    bytes: 0,
    status: 'ready'
  }
  const store: RegionsStore = {
    regions: [region],
    positionWarm: { enabled: true, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: ['seamark'] }
  }
  saveRegionsStore(dir, store)
  const loaded = loadRegionsStore(dir)
  assert.deepEqual(loaded.regions[0], region)
  assert.equal(loaded.positionWarm.enabled, true)
})

test('migrates a v2 bbox to a one-element regions list and drops the top-level box fields', () => {
  const dir = tmp()
  const v2 = {
    bbox: [-10.0, 50.0, 10.0, 60.0],
    sources: ['depth-gebco', 'seamark'],
    minzoom: 6,
    maxzoom: 12,
    positionWarm: { enabled: true, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: ['seamark'] }
  }
  writeFileSync(join(dir, 'regions.json'), JSON.stringify(v2))
  const store = loadRegionsStore(dir)
  assert.equal(store.regions.length, 1, 'the v2 bbox becomes exactly one region')
  const r = store.regions[0]
  assert.deepEqual(r.bbox, [-10.0, 50.0, 10.0, 60.0])
  assert.deepEqual(r.sourceIds, ['depth-gebco', 'seamark'])
  assert.equal(r.minzoom, 6)
  assert.equal(r.maxzoom, 12)
  assert.equal(r.status, 'needs-redownload', 'migrated region needs a re-download')
  assert.ok(typeof r.id === 'string' && r.id.length > 0, 'migrated region has an id')
  assert.ok(typeof r.name === 'string' && r.name.length > 0, 'migrated region has a name')
  // The positionWarm block is preserved unchanged.
  assert.equal(store.positionWarm.enabled, true)
  assert.deepEqual(store.positionWarm.sources, ['seamark'])
  // The top-level box fields must be absent after migration is written back.
  const raw = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')) as Record<string, unknown>
  assert.ok(!('bbox' in raw), 'bbox field must not persist after migration')
  assert.ok(!('sources' in raw), 'sources field must not persist after migration')
  assert.ok(!('minzoom' in raw), 'minzoom field must not persist after migration')
  assert.ok(!('maxzoom' in raw), 'maxzoom field must not persist after migration')
})

test('a null bbox in a v2 file yields an empty regions list', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'regions.json'), JSON.stringify({
    bbox: null,
    sources: [],
    minzoom: 6,
    maxzoom: 12,
    positionWarm: { enabled: false, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: [] }
  }))
  const store = loadRegionsStore(dir)
  assert.deepEqual(store.regions, [], 'null bbox produces no regions')
})

test('a second load of a migrated file does not create a duplicate region', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'regions.json'), JSON.stringify({
    bbox: [0.0, 0.0, 1.0, 1.0],
    sources: ['seamark'],
    minzoom: 6,
    maxzoom: 12,
    positionWarm: { enabled: false, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: [] }
  }))
  loadRegionsStore(dir) // first load triggers migration and writes back
  const second = loadRegionsStore(dir)
  assert.equal(second.regions.length, 1, 'second load must not duplicate the migrated region')
})

test('a stray top-level bbox never discards an existing regions array', () => {
  const dir = tmp()
  // A file that carries BOTH a saved regions array and a stray legacy top-level bbox: migration must
  // keep the regions and must not synthesize a legacy region from the box.
  const region: RegionsStore['regions'][0] = {
    id: 'keep-me',
    name: 'San Francisco Bay',
    bbox: [-122.5, 37.5, -122.0, 38.0],
    sourceIds: ['seamark'],
    minzoom: 6,
    maxzoom: 12,
    createdAt: 1_700_000_000,
    lastDownloadedAt: null,
    bytes: 0,
    status: 'ready'
  }
  writeFileSync(join(dir, 'regions.json'), JSON.stringify({
    regions: [region],
    bbox: [0.0, 0.0, 1.0, 1.0],
    sources: ['depth-gebco'],
    minzoom: 6,
    maxzoom: 12,
    positionWarm: { enabled: false, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: [] }
  }))
  const store = loadRegionsStore(dir)
  assert.equal(store.regions.length, 1, 'the existing region is preserved and no legacy region is added')
  assert.deepEqual(store.regions[0], region, 'the existing region is unchanged')
})
