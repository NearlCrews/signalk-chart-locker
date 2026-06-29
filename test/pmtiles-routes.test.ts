// test/pmtiles-routes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChartRegistry, type ChartRecord } from '../src/charts/chart-registry.js'
import { registerPmtilesServeRoute, type ServeRequest } from '../src/http/pmtiles-routes.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

class FakeRes extends PassThrough {
  statusCode = 0
  outHeaders: Record<string, string> = {}
  headersSent = false
  status (c: number): this { this.statusCode = c; this.headersSent = true; return this }
  setHeader (n: string, v: string): void { this.outHeaders[n.toLowerCase()] = v }
  override end (chunk?: any, ...args: any[]): this {
    this.headersSent = true
    return super.end(chunk, ...args)
  }
}

function collect (): { routes: Record<string, (req: ServeRequest, res: FakeRes) => void>, registry: ChartRegistry } {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  registerPmtilesServeRoute({ get (p, h) { routes[p] = h as (req: ServeRequest, res: FakeRes) => void } }, registry)
  return { routes, registry }
}

async function fixtureRecord (): Promise<{ record: ChartRecord, cleanup: () => Promise<void>, size: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'serve-'))
  const file = join(dir, 'sf.pmtiles')
  const bytes = buildPmtilesFixture()
  await writeFile(file, bytes)
  return {
    size: bytes.length,
    record: {
      // The registry stores the realpath at discovery, so the fixture does too; the serve route re-checks
      // realpath equality, and on macOS the tmp dir is itself a symlink.
      identifier: 'sf-pmtiles',
      fileName: 'sf.pmtiles',
      filePath: await realpath(file),
      name: 'sf',
      description: '',
      type: 'tilelayer',
      scale: 250000,
      decoded: { minzoom: 0, maxzoom: 14, format: 'mvt', vectorLayers: [] }
    },
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

function req (file: string, headers: Record<string, string> = {}): ServeRequest {
  return { params: { file }, headers }
}

async function finished (res: FakeRes): Promise<Buffer> {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  await new Promise((resolve) => res.on('finish', resolve))
  return Buffer.concat(chunks)
}

test('an unknown id returns 404', async () => {
  const { routes } = collect()
  const res = new FakeRes()
  routes['/pmtiles/:file'](req('nope.pmtiles'), res)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.statusCode, 404)
})

test('a full GET returns 200 with a strong ETag and Accept-Ranges', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), res)
    const body = await finished(res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.outHeaders['accept-ranges'], 'bytes')
    assert.match(res.outHeaders.etag, /^"\d+-\d+"$/)
    assert.equal(res.outHeaders.etag.startsWith('"W/'), false)
    assert.equal(body.length, size)
  } finally {
    await cleanup()
  }
})

test('a Range request returns 206 with Content-Range and the partial body', async () => {
  const { routes, registry } = collect()
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6' }), res)
    const body = await finished(res)
    assert.equal(res.statusCode, 206)
    assert.match(res.outHeaders['content-range'], /^bytes 0-6\/\d+$/)
    assert.equal(body.toString('ascii'), 'PMTiles')
  } finally {
    await cleanup()
  }
})

test('an If-None-Match that matches returns 304', async () => {
  const { routes, registry } = collect()
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const first = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), first)
    await finished(first)
    const etag = first.outHeaders.etag
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { 'if-none-match': etag }), res)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 304)
  } finally {
    await cleanup()
  }
})

test('an If-None-Match that matches returns 304 even when a Range header is present', async () => {
  const { routes, registry } = collect()
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const first = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), first)
    await finished(first)
    const etag = first.outHeaders.etag
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6', 'if-none-match': etag }), res)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 304, 'If-None-Match wins over Range')
  } finally {
    await cleanup()
  }
})

test('an If-None-Match wildcard returns 304 when the resource exists', async () => {
  const { routes, registry } = collect()
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { 'if-none-match': '*' }), res)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 304)
  } finally {
    await cleanup()
  }
})

test('a path swapped to a symlink escaping the directory after registration returns 404', async () => {
  const { routes, registry } = collect()
  const dir = await mkdtemp(join(tmpdir(), 'serve-'))
  const outside = await mkdtemp(join(tmpdir(), 'outside-'))
  const file = join(dir, 'sf.pmtiles')
  await writeFile(file, buildPmtilesFixture())
  const secret = join(outside, 'secret.pmtiles')
  await writeFile(secret, buildPmtilesFixture())
  registry.set({
    identifier: 'sf-pmtiles',
    fileName: 'sf.pmtiles',
    filePath: await realpath(file),
    name: 'sf',
    description: '',
    type: 'tilelayer',
    scale: 250000,
    decoded: { minzoom: 0, maxzoom: 14, format: 'mvt', vectorLayers: [] }
  })
  try {
    // Swap the discovered real file for a symlink pointing outside the directory; the serve realpath check
    // sees the changed resolution and rejects it.
    await unlink(file)
    await symlink(secret, file)
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), res)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 404)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('an If-Range that does not match returns the full 200, not a 206', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6', 'if-range': '"stale-validator"' }), res)
    const body = await finished(res)
    assert.equal(res.statusCode, 200)
    assert.equal(body.length, size)
  } finally {
    await cleanup()
  }
})

test('an unsatisfiable range returns 416', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: `bytes=${size + 10}-${size + 20}` }), res)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 416)
    assert.equal(res.outHeaders['content-range'], `bytes */${size}`)
  } finally {
    await cleanup()
  }
})
