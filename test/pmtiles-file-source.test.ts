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

test('getBytes reads a mid-file range at non-zero offset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-src-'))
  const file = join(dir, 'a.pmtiles')
  const fixture = buildPmtilesFixture()
  await writeFile(file, fixture)
  try {
    const source = new PmtilesFileSource(file)
    const { data } = await source.getBytes(24, 8)
    const expected = fixture.subarray(24, 32)
    assert.deepEqual(Buffer.from(data), expected)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getBytes rejects unsafe, oversized, and out-of-file ranges before allocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-src-'))
  const file = join(dir, 'a.pmtiles')
  await writeFile(file, buildPmtilesFixture())
  try {
    const source = new PmtilesFileSource(file)
    await assert.rejects(source.getBytes(0, 17 * 1024 * 1024), /too large/i)
    await assert.rejects(source.getBytes(Number.MAX_SAFE_INTEGER, 10), /invalid|beyond/i)
    await assert.rejects(source.getBytes(10_000, 1), /beyond/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getBytes fills the requested range across short regular-file reads', async () => {
  const bytes = Buffer.from('PMTiles-short-read')
  let reads = 0
  const fakeHandle = {
    async stat () { return { size: bytes.length } },
    async read (buffer: Buffer, offset: number, length: number, position: number) {
      reads++
      const bytesRead = Math.min(2, length, bytes.length - position)
      if (bytesRead > 0) bytes.copy(buffer, offset, position, position + bytesRead)
      return { bytesRead, buffer }
    },
    async close () {}
  }
  const source = new PmtilesFileSource('mock.pmtiles', { open: (async () => fakeHandle) as never })
  const result = await source.getBytes(0, bytes.length)
  assert.deepEqual(Buffer.from(result.data), bytes)
  assert.ok(reads > 1)
})
