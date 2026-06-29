// test/chart-overrides.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OverrideStore } from '../src/charts/overrides.js'

test('the override store persists and reloads per-chart overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-'))
  const file = join(dir, 'pmtiles-overrides.json')
  try {
    const store = new OverrideStore(file)
    store.load()
    store.set('sf-pmtiles', { name: 'San Francisco Bay', description: 'NOAA ENC' })
    const reloaded = new OverrideStore(file)
    reloaded.load()
    assert.deepEqual(reloaded.get('sf-pmtiles'), { name: 'San Francisco Bay', description: 'NOAA ENC' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the namer applies an override over the decoded name, falling back to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-'))
  const file = join(dir, 'pmtiles-overrides.json')
  try {
    const store = new OverrideStore(file)
    store.load()
    store.set('sf-pmtiles', { name: 'Renamed', scale: 80000 })
    const namer = store.namer()
    const decoded = { minzoom: 0, maxzoom: 14, format: 'mvt' as const, vectorLayers: [], name: 'Decoded Name' }
    assert.deepEqual(namer('sf.pmtiles', decoded), { name: 'Renamed', description: '', scale: 80000 })
    assert.deepEqual(namer('other.pmtiles', decoded), { name: 'Decoded Name', description: '', scale: 250000 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
