// test/pmtiles-metadata.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises'
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

test('an antimeridian-crossing bounds box is retained', async () => {
  const crossing = buildPmtilesFixture({ minLonE7: 1_700_000_000, minLatE7: -100_000_000, maxLonE7: -1_700_000_000, maxLatE7: 100_000_000 })
  await withFixture(crossing, async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.decoded.bounds, [170, -10, -170, 10])
  })
})

test('out-of-world header bounds are omitted', async () => {
  const outOfWorld = buildPmtilesFixture({ minLonE7: -2_000_000_000, minLatE7: -1_000_000_000, maxLonE7: 2_000_000_000, maxLatE7: 1_000_000_000 })
  await withFixture(outOfWorld, async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.decoded.bounds, undefined)
  })
})

test('an invalid or unsupported zoom range is rejected', async () => {
  for (const bytes of [buildPmtilesFixture({ minZoom: 12, maxZoom: 3 }), buildPmtilesFixture({ minZoom: 0, maxZoom: 27 })]) {
    await withFixture(bytes, async (file) => {
      const result = await decodePmtilesArchive(file)
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /zoom range/i)
    })
  }
})

test('an archive section extending beyond the file is rejected', async () => {
  const bytes = buildPmtilesFixture()
  bytes.writeBigUInt64LE(999_999n, 32)
  await withFixture(bytes, async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /outside the file/i)
  })
})

test('oversized metadata is ignored without allocating an unbounded decode', async () => {
  const bytes = buildPmtilesFixture({ metadata: { name: 'x'.repeat(1024 * 1024 + 1) } })
  await withFixture(bytes, async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.decoded.name, undefined)
  })
})

test('metadata names and vector-layer ids are bounded, normalized, and deduplicated', async () => {
  const metadata = {
    name: ` ${'x'.repeat(600)} `,
    vector_layers: [
      { id: '' },
      { id: ' water ' },
      { id: 'water' },
      { id: 'bad\nlayer' },
      { id: 'x'.repeat(257) },
      { id: 'depth' }
    ]
  }
  await withFixture(buildPmtilesFixture({ metadata }), async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.decoded.name, undefined)
    assert.deepEqual(result.decoded.vectorLayers, ['water', 'depth'])
  })
})

test('metadata display fields reject leading and embedded control characters', async () => {
  for (const control of ['\n', '\u0085', '\u2028', '\u2029']) {
    const metadata = {
      name: `${control}Unsafe name`,
      vector_layers: [{ id: `unsafe${control}layer` }, { id: 'safe' }]
    }
    await withFixture(buildPmtilesFixture({ metadata }), async (file) => {
      const result = await decodePmtilesArchive(file)
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.decoded.name, undefined)
      assert.deepEqual(result.decoded.vectorLayers, ['safe'])
    })
  }
})

test('a truncated file is rejected with a clear error message', async () => {
  const truncated = Buffer.alloc(4)
  await withFixture(truncated, async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /(bad magic|cannot read archive)/i)
  })
})

test('a nonexistent file is rejected with a cannot read archive error', async () => {
  const nonexistent = '/tmp/does-not-exist-pmtiles-' + Date.now() + '.pmtiles'
  const result = await decodePmtilesArchive(nonexistent)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /cannot read archive/i)
})

test('the fixed header is filled across short regular-file reads', async () => {
  await withFixture(buildPmtilesFixture(), async (file) => {
    let reads = 0
    const shortOpen = async () => {
      const handle = await open(file, 'r')
      return {
        stat: handle.stat.bind(handle),
        async read (buffer: Buffer, offset: number, length: number, position: number) {
          reads++
          return await handle.read(buffer, offset, Math.min(length, 11), position)
        },
        close: handle.close.bind(handle)
      }
    }
    const result = await decodePmtilesArchive(file, { open: shortOpen as never })
    assert.equal(result.ok, true)
    assert.ok(reads > 1)
  })
})
