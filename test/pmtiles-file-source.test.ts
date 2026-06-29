import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PmtilesFileSource } from '../src/charts/pmtiles-file-source.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

test('getBytes reads the requested range off disk and getKey returns the path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-src-'))
  const file = join(dir, 'a.pmtiles')
  await writeFile(file, buildPmtilesFixture())
  try {
    const source = new PmtilesFileSource(file)
    assert.equal(source.getKey(), file)
    const { data } = await source.getBytes(0, 7)
    assert.equal(Buffer.from(data).toString('ascii'), 'PMTiles')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getBytes returns only the available bytes when the range runs past end of file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-src-'))
  const file = join(dir, 'a.pmtiles')
  const fixture = buildPmtilesFixture()
  await writeFile(file, fixture)
  try {
    const source = new PmtilesFileSource(file)
    const { data } = await source.getBytes(0, 16384)
    assert.equal(data.byteLength, fixture.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
