import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegionsStore, saveRegionsStore, mutateRegionsStore, createCachedRegionsLoader, reconcilePositionWarmSources, DEFAULT_REGIONS_STORE, MAX_SAVED_REGIONS, type RegionsStore } from '../src/runtime/regions-store.js'

function tmp (): string {
  return mkdtempSync(join(tmpdir(), 'regions-store-'))
}

test('createCachedRegionsLoader serves the store from cache and stop is idempotent', () => {
  const dir = tmp()
  saveRegionsStore(dir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 21 })
  const loader = createCachedRegionsLoader(dir)
  const first = loader.getStore()
  assert.equal(first.cacheScrollTtlDays, 21)
  // A second call within the self-heal window serves the identical cached object without re-reading.
  assert.equal(loader.getStore(), first, 'cached store identity is stable between writes')
  loader.stop()
  loader.stop() // idempotent: a second stop must not throw
})

test('createCachedRegionsLoader with a missing file returns store defaults', () => {
  const dir = tmp()
  const loader = createCachedRegionsLoader(dir)
  const store = loader.getStore()
  assert.deepEqual(store.regions, [])
  assert.equal(store.positionWarm.enabled, DEFAULT_REGIONS_STORE.positionWarm.enabled)
  loader.stop()
})

// Linux only: this asserts fs.watch fires an invalidation, and fs.watch delays or drops events on macOS
// and Windows CI. The mtime self-heal keeps the loader correct on every platform regardless.
test('createCachedRegionsLoader picks up a write through the watcher', { skip: process.platform !== 'linux' }, async () => {
  const dir = tmp()
  saveRegionsStore(dir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 10 })
  const loader = createCachedRegionsLoader(dir)
  assert.equal(loader.getStore().cacheScrollTtlDays, 10)
  saveRegionsStore(dir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 30 })
  // Poll for the watcher-driven invalidation for up to two seconds.
  const deadline = Date.now() + 2000
  while (loader.getStore().cacheScrollTtlDays !== 30 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(loader.getStore().cacheScrollTtlDays, 30, 'a write is picked up after the watch event')
  loader.stop()
})

test('a corrupt file falls back to an empty store rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regions-store-'))
  writeFileSync(join(dir, 'regions.json'), 'not json')
  const store = loadRegionsStore(dir)
  assert.deepEqual(store.regions, [])
  assert.equal(store.positionWarm.enabled, true)
})

test('a valid JSON scalar is preserved and falls back without throwing', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'regions.json'), 'null')
  assert.deepEqual(loadRegionsStore(dir).regions, [])
  assert.ok(readdirSync(dir).some((name) => name.startsWith('regions.json.corrupt-')))
})

test('semantically malformed state is normalized without reaching runtime consumers', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'regions.json'), JSON.stringify({
    regions: [null, { id: 'bad', name: 'Bad', bbox: [180, 0, -180, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, createdAt: 1, lastDownloadedAt: null, bytes: 0, status: 'ready' }],
    positionWarm: { enabled: 'yes', radiusMeters: -1, moveThresholdMeters: null, intervalSecs: 1, baseZoom: 99, sources: ['same', 'same'] },
    cacheScrollTtlDays: -4
  }))
  const store = loadRegionsStore(dir)
  assert.deepEqual(store.regions, [])
  assert.deepEqual(store.positionWarm, DEFAULT_REGIONS_STORE.positionWarm)
  assert.equal(store.cacheScrollTtlDays, DEFAULT_REGIONS_STORE.cacheScrollTtlDays)
  assert.ok(readdirSync(dir).some((name) => name.startsWith('regions.json.corrupt-')))
})

test('saved region display text, identifiers, and source IDs reject control characters and preserve the source state', () => {
  const base = {
    id: 'region-1',
    name: 'Area',
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: null,
    bytes: 0,
    status: 'ready'
  }
  for (const region of [
    { ...base, name: 'bad\u2029name' },
    { ...base, id: 'bad\nid' },
    { ...base, sourceIds: ['bad\u0085source'] }
  ]) {
    const dir = tmp()
    writeFileSync(join(dir, 'regions.json'), JSON.stringify({ regions: [region] }))
    assert.deepEqual(loadRegionsStore(dir).regions, [])
    const backup = readdirSync(dir).find((name) => name.startsWith('regions.json.corrupt-'))
    assert.ok(backup)
    assert.match(readFileSync(join(dir, backup), 'utf8'), /bad/)
  }
})

test('a malformed saved region is preserved before a later mutation writes normalized state', () => {
  const dir = tmp()
  const valid = {
    id: 'keep',
    name: 'Keep',
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: null,
    bytes: 7,
    status: 'ready'
  }
  writeFileSync(join(dir, 'regions.json'), JSON.stringify({ regions: [valid, { id: 'broken' }], cacheScrollTtlDays: 10 }))
  mutateRegionsStore(dir, (store) => { store.cacheScrollTtlDays = 11 })
  const loaded = loadRegionsStore(dir)
  assert.equal(loaded.cacheScrollTtlDays, 11)
  assert.deepEqual(loaded.regions, [valid])
  const backup = readdirSync(dir).find((name) => name.startsWith('regions.json.corrupt-'))
  assert.ok(backup)
  assert.match(readFileSync(join(dir, backup), 'utf8'), /"broken"/)
})

test('self-heal detects a replacement identity even when its timestamp component is unchanged', () => {
  const dir = tmp()
  saveRegionsStore(dir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 10 })
  let now = 0
  let identity = '1:10:100:123456789'
  const loader = createCachedRegionsLoader(dir, {
    watch: false,
    selfHealMs: 1,
    now: () => now,
    statIdentity: () => identity
  })
  assert.equal(loader.getStore().cacheScrollTtlDays, 10)
  saveRegionsStore(dir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 20 })
  identity = '1:11:100:123456789'
  now = 2
  assert.equal(loader.getStore().cacheScrollTtlDays, 20)
  loader.stop()
})

test('fresh directory returns empty regions list and default position-warm', () => {
  const store = loadRegionsStore(tmp())
  assert.deepEqual(store.regions, [])
  // Auto-cache ships on but with no charts picked, so the panel prompts the navigator to choose.
  assert.equal(store.positionWarm.enabled, true)
  assert.deepEqual(store.positionWarm.sources, [])
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
    positionWarm: { enabled: true, radiusMeters: 3704, moveThresholdMeters: 1852, intervalSecs: 60, baseZoom: 12, sources: ['seamark'] },
    cacheScrollTtlDays: 30
  }
  saveRegionsStore(dir, store)
  const loaded = loadRegionsStore(dir)
  assert.deepEqual(loaded.regions[0], region)
  assert.equal(loaded.positionWarm.enabled, true)
})

test('the regions store defaults cacheScrollTtlDays to 30', () => {
  assert.equal(loadRegionsStore(tmp()).cacheScrollTtlDays, 30)
})

test('positionWarmBudgetBytes rejects malformed inputs and bounds valid reserves', async () => {
  const { positionWarmBudgetBytes } = await import('../src/runtime/regions-store.js')
  assert.equal(positionWarmBudgetBytes(Number.NaN), 0)
  assert.equal(positionWarmBudgetBytes(Number.POSITIVE_INFINITY), 0)
  assert.equal(positionWarmBudgetBytes(-1), 0)
  assert.equal(positionWarmBudgetBytes(9), 0)
  assert.equal(positionWarmBudgetBytes(15), 1)
  assert.equal(positionWarmBudgetBytes(1024 ** 4), 64 * 1024 * 1024)
})

test('cacheScrollTtlDays round-trips through save and load', () => {
  const dir = tmp()
  const base = loadRegionsStore(dir)
  saveRegionsStore(dir, { ...base, cacheScrollTtlDays: 7 })
  assert.equal(loadRegionsStore(dir).cacheScrollTtlDays, 7)
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

test('a v2 bbox without any valid sources does not create an unusable region', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'regions.json'), JSON.stringify({
    bbox: [-10, 50, 10, 60],
    sources: [],
    minzoom: 6,
    maxzoom: 12
  }))
  assert.deepEqual(loadRegionsStore(dir).regions, [])
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

test('loaded saved regions are bounded', () => {
  const dir = tmp()
  const regions = Array.from({ length: MAX_SAVED_REGIONS + 25 }, (_, index) => ({
    id: `region-${index}`,
    name: `Region ${index}`,
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: null,
    bytes: 0,
    status: 'ready'
  }))
  writeFileSync(join(dir, 'regions.json'), JSON.stringify({ regions }))
  assert.equal(loadRegionsStore(dir).regions.length, MAX_SAVED_REGIONS)
})

test('source reconciliation removes stale automatic sources but preserves saved region metadata', () => {
  const dir = tmp()
  const region: RegionsStore['regions'][0] = {
    id: 'keep',
    name: 'Keep cached',
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark', 'removed-source'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: 1,
    bytes: 100,
    status: 'ready'
  }
  saveRegionsStore(dir, {
    ...DEFAULT_REGIONS_STORE,
    regions: [region],
    positionWarm: { ...DEFAULT_REGIONS_STORE.positionWarm, sources: ['seamark', 'removed-source'] }
  })
  assert.deepEqual(reconcilePositionWarmSources(dir, (id) => id === 'seamark'), ['removed-source'])
  const store = loadRegionsStore(dir)
  assert.deepEqual(store.positionWarm.sources, ['seamark'])
  assert.deepEqual(store.regions[0]?.sourceIds, ['seamark', 'removed-source'])
})
