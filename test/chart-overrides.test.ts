// test/chart-overrides.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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

test('the override store rejects and preserves a wrong JSON root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-'))
  const file = join(dir, 'pmtiles-overrides.json')
  try {
    await writeFile(file, 'null')
    const store = new OverrideStore(file)
    assert.doesNotThrow(() => store.load())
    assert.equal(store.get('anything'), undefined)
    assert.ok((await readdir(dir)).some((name) => name.startsWith('pmtiles-overrides.json.corrupt-')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the override store preserves semantically unbounded durable state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-'))
  const file = join(dir, 'pmtiles-overrides.json')
  try {
    await writeFile(file, JSON.stringify({ chart: { name: 'x'.repeat(121), scale: Number.MAX_SAFE_INTEGER + 1 } }))
    const store = new OverrideStore(file)
    store.load()
    assert.equal(store.get('chart'), undefined)
    assert.ok((await readdir(dir)).some((name) => name.startsWith('pmtiles-overrides.json.corrupt-')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the override store preserves durable state containing display controls before normalization', async () => {
  for (const override of [{ name: 'bad\nname' }, { description: 'bad\u2029description' }]) {
    const dir = await mkdtemp(join(tmpdir(), 'ov-controls-'))
    const file = join(dir, 'pmtiles-overrides.json')
    try {
      await writeFile(file, JSON.stringify({ chart: override }))
      const store = new OverrideStore(file)
      store.load()
      assert.equal(store.get('chart'), undefined)
      assert.ok((await readdir(dir)).some((name) => name.startsWith('pmtiles-overrides.json.corrupt-')))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

test('a failed override write does not change the live in-memory value', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-fail-'))
  const file = join(dir, 'pmtiles-overrides.json')
  const store = new OverrideStore(file)
  try {
    store.load()
    store.set('chart', { name: 'Before' })
    await chmod(dir, 0o500)
    assert.throws(() => store.set('chart', { name: 'After' }))
    assert.deepEqual(store.get('chart'), { name: 'Before' })
  } finally {
    await chmod(dir, 0o700)
    await rm(dir, { recursive: true, force: true })
  }
})
