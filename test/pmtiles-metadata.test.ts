// test/pmtiles-metadata.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePmtilesArchive } from '../src/charts/pmtiles-metadata.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

async function withFixture (bytes: Buffer, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-meta-'))
  const file = join(dir, 'chart.pmtiles')
  await writeFile(file, bytes)
  try {
    await run(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a good vector archive decodes with bounds, zoom, format, and layers', async () => {
  await withFixture(buildPmtilesFixture(), async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.decoded.bounds, [-122, 37, -121, 38])
    assert.equal(result.decoded.minzoom, 0)
    assert.equal(result.decoded.maxzoom, 14)
    assert.equal(result.decoded.format, 'mvt')
    assert.deepEqual(result.decoded.vectorLayers, ['water'])
    assert.equal(result.decoded.name, 'Test Chart')
  })
})

test('a bad magic is rejected as not a PMTiles archive', async () => {
  await withFixture(buildPmtilesFixture({ magic: 'XXXXXXX' }), async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /magic/i)
  })
})

test('an unknown tile type is rejected', async () => {
  await withFixture(buildPmtilesFixture({ tileType: 0 }), async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /tile type/i)
  })
})

test('a degenerate bounds box is dropped, not an error', async () => {
  const flat = buildPmtilesFixture({ minLonE7: 0, minLatE7: 0, maxLonE7: 0, maxLatE7: 0 })
  await withFixture(flat, async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.decoded.bounds, undefined)
  })
})
