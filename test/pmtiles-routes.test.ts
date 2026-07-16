// test/pmtiles-routes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { fstatSync, type ReadStream } from 'node:fs'
import { mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChartRegistry, type ChartRecord } from '../src/charts/chart-registry.js'
import { registerPmtilesServeRoute, type ServeRequest } from '../src/http/pmtiles-routes.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

class FakeRes extends PassThrough {
  statusCode = 0
  outHeaders: Record<string, string> = {}
  headersSent = false
  status (c: number): this { this.statusCode = c; return this }
  setHeader (n: string, v: string): void { this.outHeaders[n.toLowerCase()] = v }
  removeHeader (n: string): void { delete this.outHeaders[n.toLowerCase()] }
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

test('the serve route returns 409 while PMTiles support is disabled', async () => {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  registerPmtilesServeRoute({ get (p, h) { routes[p] = h as never } }, new ChartRegistry(), () => false)
  const res = new FakeRes()
  routes['/pmtiles/:file'](req('sf.pmtiles'), res)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.statusCode, 409)
  assert.equal(res.outHeaders['x-content-type-options'], 'nosniff')
})

async function fixtureRecord (): Promise<{ record: ChartRecord, cleanup: () => Promise<void>, size: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'serve-'))
  const file = join(dir, 'sf.pmtiles')
  const bytes = buildPmtilesFixture()
  await writeFile(file, bytes)
  const info = await stat(file, { bigint: true })
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
      decoded: { minzoom: 0, maxzoom: 14, format: 'mvt', vectorLayers: [] },
      mtimeMs: Number(info.mtimeMs),
      mtimeNs: info.mtimeNs,
      device: info.dev,
      inode: info.ino,
      bytes: Number(info.size)
    },
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

function req (file: string, headers: Record<string, string> = {}, method = 'GET'): ServeRequest {
  return { params: { file }, headers, method }
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
    assert.match(res.outHeaders.etag, /^"\d+-\d+-\d+-\d+"$/)
    assert.equal(res.outHeaders.etag.startsWith('"W/'), false)
    assert.equal(res.outHeaders['cache-control'], 'public, max-age=0, must-revalidate')
    assert.equal(res.outHeaders['x-content-type-options'], 'nosniff')
    assert.equal(body.length, size)
  } finally {
    await cleanup()
  }
})

test('a synchronous source-stream construction failure closes the descriptor and returns a clean 500', async () => {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  let descriptor: number | undefined
  registerPmtilesServeRoute(
    { get (path, handler) { routes[path] = handler as (req: ServeRequest, res: FakeRes) => void } },
    registry,
    () => true,
    {
      createReadStream: ((_path: string, options: { fd?: number }) => {
        descriptor = options.fd
        throw new Error('stream construction failed')
      }) as never
    }
  )
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    const done = finished(res)
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6' }), res)
    await done
    assert.equal(res.statusCode, 500)
    for (const header of ['accept-ranges', 'etag', 'content-type', 'cache-control', 'content-length', 'content-range']) {
      assert.equal(res.outHeaders[header], undefined)
    }
    assert.notEqual(descriptor, undefined)
    assert.throws(() => { fstatSync(descriptor!) }, (error: NodeJS.ErrnoException) => error.code === 'EBADF')
  } finally {
    await cleanup()
  }
})

test('a source error before headers removes range lengths before returning 500', async () => {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  registerPmtilesServeRoute(
    { get (path, handler) { routes[path] = handler as (req: ServeRequest, res: FakeRes) => void } },
    registry,
    () => true,
    {
      createReadStream: (() => new Readable({
        read () { this.destroy(new Error('read failed')) }
      }) as ReadStream) as never
    }
  )
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    const done = finished(res)
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6' }), res)
    await done
    assert.equal(res.statusCode, 500)
    for (const header of ['accept-ranges', 'etag', 'content-type', 'cache-control', 'content-length', 'content-range']) {
      assert.equal(res.outHeaders[header], undefined)
    }
  } finally {
    await cleanup()
  }
})

test('a throwing stream observer destroys the created stream and returns a clean 500', async () => {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  let closed: Promise<void> | undefined
  registerPmtilesServeRoute(
    { get (path, handler) { routes[path] = handler as (req: ServeRequest, res: FakeRes) => void } },
    registry,
    () => true,
    {
      onStream: (stream) => {
        closed = new Promise((resolve) => { stream.once('close', resolve) })
        throw new Error('observer failed')
      }
    }
  )
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    const done = finished(res)
    routes['/pmtiles/:file'](req('sf.pmtiles'), res)
    await done
    await closed
    assert.equal(res.statusCode, 500)
    assert.equal(res.outHeaders.etag, undefined)
  } finally {
    await cleanup()
  }
})

test('HEAD returns full and range headers without creating a source stream', async () => {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  let streams = 0
  registerPmtilesServeRoute(
    { get (path, handler) { routes[path] = handler as (req: ServeRequest, res: FakeRes) => void } },
    registry,
    () => true,
    { onStream: () => { streams++ } }
  )
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const full = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', {}, 'HEAD'), full)
    assert.equal((await finished(full)).length, 0)
    assert.equal(full.statusCode, 200)
    assert.equal(full.outHeaders['content-length'], String(size))
    assert.equal(full.outHeaders['cache-control'], 'public, max-age=0, must-revalidate')

    const range = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6' }, 'HEAD'), range)
    assert.equal((await finished(range)).length, 0)
    assert.equal(range.statusCode, 206)
    assert.equal(range.outHeaders['content-length'], '7')
    assert.match(range.outHeaders['content-range'], /^bytes 0-6\/\d+$/)
    assert.equal(streams, 0)
  } finally {
    await cleanup()
  }
})

test('conditional and unsatisfiable HEAD requests close without streaming', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const first = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), first)
    await finished(first)

    const conditional = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { 'if-none-match': first.outHeaders.etag }, 'HEAD'), conditional)
    assert.equal((await finished(conditional)).length, 0)
    assert.equal(conditional.statusCode, 304)
    assert.equal(conditional.outHeaders['cache-control'], 'public, max-age=0, must-revalidate')

    const unsatisfiable = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: `bytes=${size + 1}-` }, 'HEAD'), unsatisfiable)
    assert.equal((await finished(unsatisfiable)).length, 0)
    assert.equal(unsatisfiable.statusCode, 416)
    assert.equal(unsatisfiable.outHeaders['content-range'], `bytes */${size}`)
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

test('If-None-Match uses weak comparison across an entity-tag list', async () => {
  const { routes, registry } = collect()
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const first = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), first)
    await finished(first)
    const etag = first.outHeaders.etag
    for (const value of [`W/${etag}`, `"other", W/${etag}`, ` W/"other" , ${etag} `]) {
      const res = new FakeRes()
      routes['/pmtiles/:file'](req('sf.pmtiles', { 'if-none-match': value }), res)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(res.statusCode, 304)
    }
  } finally {
    await cleanup()
  }
})

test('a malformed If-None-Match list is ignored', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const first = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), first)
    await finished(first)
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { 'if-none-match': `garbage ${first.outHeaders.etag}` }), res)
    const body = await finished(res)
    assert.equal(res.statusCode, 200)
    assert.equal(body.length, size)
  } finally {
    await cleanup()
  }
})

test('disconnecting a PMTiles response destroys and closes the source stream', async () => {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  let source: ReadStream | undefined
  registerPmtilesServeRoute(
    { get (p, h) { routes[p] = h as (req: ServeRequest, res: FakeRes) => void } },
    registry,
    () => true,
    { onStream: (stream) => { source = stream } }
  )
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    res.pause()
    routes['/pmtiles/:file'](req('sf.pmtiles'), res)
    assert.ok(source)
    const closed = new Promise<void>((resolve) => source?.once('close', resolve))
    res.destroy()
    await closed
    assert.equal(source.destroyed, true)
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
  const info = await stat(file, { bigint: true })
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
    decoded: { minzoom: 0, maxzoom: 14, format: 'mvt', vectorLayers: [] },
    mtimeMs: Number(info.mtimeMs),
    mtimeNs: info.mtimeNs,
    device: info.dev,
    inode: info.ino,
    bytes: Number(info.size)
  })
  try {
    // Swap the discovered real file for a symlink pointing outside the directory; the opened
    // descriptor no longer matches the identity captured during discovery and is rejected.
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
