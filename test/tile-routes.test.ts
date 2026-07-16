import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { registerTileRoutes, type TileRouter, type ProxyRequest, type ProxyFetch } from '../src/http/tile-routes.js'

class FakeRes extends PassThrough {
  statusCode = 0
  outHeaders: Record<string, string> = {}
  headersSent = false
  status (c: number): this {
    this.statusCode = c
    return this
  }

  setHeader (n: string, v: string): void {
    this.outHeaders[n.toLowerCase()] = v
  }
}

function collectRoutes (): { routes: Record<string, (req: ProxyRequest, res: never) => void>, router: TileRouter } {
  const routes: Record<string, (req: ProxyRequest, res: never) => void> = {}
  const router: TileRouter = { get (path, handler) { routes[path] = handler as (req: ProxyRequest, res: never) => void } }
  return { routes, router }
}

function fakeReq (url: string, headers: Record<string, string> = {}): ProxyRequest & { triggerClose: () => void, triggerAborted: () => void } {
  const closeCb: () => void = () => {}
  let abortedCb: () => void = () => {}
  return {
    url,
    headers,
    on (_event, cb) { abortedCb = cb },
    triggerClose () { closeCb() },
    triggerAborted () { abortedCb() }
  } as ProxyRequest & { triggerClose: () => void, triggerAborted: () => void }
}

const tilePath = '/tile/:source/:z/:x/:y'

test('tiles/ready reports 200 with an address and 503 without one', () => {
  const { routes, router } = collectRoutes()
  let addr: string | null = null
  registerTileRoutes(router, () => addr)
  const r1 = new FakeRes()
  routes['/tiles/ready'](fakeReq('/tiles/ready'), r1 as never)
  assert.equal(r1.statusCode, 503)
  addr = 'x:8080'
  const r2 = new FakeRes()
  routes['/tiles/ready'](fakeReq('/tiles/ready'), r2 as never)
  assert.equal(r2.statusCode, 200)
})

test('tiles/ready remains unavailable until configuration and health are ready', () => {
  const { routes, router } = collectRoutes()
  let ready = false
  registerTileRoutes(router, () => 'x:8080', undefined, '/plugins/signalk-chart-locker', () => ready)
  const pending = new FakeRes()
  routes['/tiles/ready'](fakeReq('/tiles/ready'), pending as never)
  assert.equal(pending.statusCode, 503)
  ready = true
  const available = new FakeRes()
  routes['/tiles/ready'](fakeReq('/tiles/ready'), available as never)
  assert.equal(available.statusCode, 200)
})

test('a tile request with no tilecache address returns 503', async () => {
  const { routes, router } = collectRoutes()
  registerTileRoutes(router, () => null)
  const res = new FakeRes()
  routes[tilePath](fakeReq('/tile/s/1/0/0'), res as never)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.statusCode, 503)
})

test('tile and style proxies reject raw and recursively encoded traversal before container fetch', async () => {
  const { routes, router } = collectRoutes()
  let fetches = 0
  const fetchImpl: ProxyFetch = async () => {
    fetches++
    return new Response(null, { status: 204 })
  }
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const attempts: Array<[string, string]> = [
    [tilePath, '/tile/source/1/../../cache/stats'],
    ['/style/:source/*', '/style/source/%2e%2e/%2e%2e/cache/stats'],
    ['/style/:source/*', '/style/source/..\\..\\cache\\stats'],
    ['/style/:source/*', '/style/source/%255c..%255ccache%255cstats'],
    ['/style/:source/*', '/style/source/%2525252e%2525252e/cache/stats'],
    ['/style/:source/*', '/style/source/%2525252fconfig']
  ]
  for (const [route, url] of attempts) {
    const res = new FakeRes()
    routes[route](fakeReq(url), res as never)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 400, url)
  }
  assert.equal(fetches, 0)
})

test('a tile request relays the status, headers, range, and body', async () => {
  const { routes, router } = collectRoutes()
  let capturedUrl = ''
  let capturedRange: string | undefined
  const fetchImpl: ProxyFetch = async (url, init) => {
    capturedUrl = url
    capturedRange = init.headers.range
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png', etag: '"abc"' } })
  }
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const res = new FakeRes()
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise((resolve) => res.on('finish', resolve))
  routes[tilePath](fakeReq('/tile/s/1/0/0', { range: 'bytes=0-1' }), res as never)
  await done
  assert.equal(capturedUrl, 'http://c:8080/tile/s/1/0/0')
  assert.equal(capturedRange, 'bytes=0-1')
  assert.equal(res.statusCode, 200)
  assert.equal(res.outHeaders['content-type'], 'image/png')
  assert.equal(res.outHeaders['x-content-type-options'], 'nosniff')
  assert.equal(res.outHeaders.etag, '"abc"')
  assert.equal(Buffer.concat(chunks).length, 3)
})

test('a 304 from the container ends without a body', async () => {
  const { routes, router } = collectRoutes()
  const fetchImpl: ProxyFetch = async () => new Response(null, { status: 304, headers: { etag: '"abc"' } })
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const res = new FakeRes()
  routes[tilePath](fakeReq('/tile/s/1/0/0', { 'if-none-match': '"abc"' }), res as never)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.statusCode, 304)
  assert.equal(res.outHeaders.etag, '"abc"')
})

test('a browser cancel aborts the upstream fetch', async () => {
  const { routes, router } = collectRoutes()
  let aborted = false
  const fetchImpl: ProxyFetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
  })
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const res = new FakeRes()
  const req = fakeReq('/tile/s/1/0/0')
  routes[tilePath](req, res as never)
  res.emit('close')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(aborted, true)
})

test('a normal completed request close does not abort the pending upstream response', async () => {
  const { routes, router } = collectRoutes()
  let signal: AbortSignal | undefined
  let resolveFetch: ((response: Response) => void) | undefined
  const fetchImpl: ProxyFetch = (_url, init) => {
    signal = init.signal
    return new Promise<Response>((resolve) => { resolveFetch = resolve })
  }
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const res = new FakeRes()
  const done = new Promise((resolve) => res.on('finish', resolve))
  const req = fakeReq('/tile/s/1/0/0')
  routes[tilePath](req, res as never)
  req.triggerClose()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(signal?.aborted, false)
  resolveFetch?.(new Response(new Uint8Array([1]), { status: 200 }))
  await done
  assert.equal(res.statusCode, 200)
})

test('an aborted incoming request aborts the pending upstream response', async () => {
  const { routes, router } = collectRoutes()
  let aborted = false
  const fetchImpl: ProxyFetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
  })
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const req = fakeReq('/tile/s/1/0/0')
  routes[tilePath](req, new FakeRes() as never)
  req.triggerAborted()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(aborted, true)
})

test('the style route rewrites the sprite to an absolute same-origin URL and passes other fields through', async () => {
  const { routes, router } = collectRoutes()
  const upstreamStyle = {
    version: 8,
    sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
    glyphs: '/plugins/signalk-chart-locker/style/basemap/glyphs/{fontstack}/{range}.pbf',
    sources: { openmaptiles: { type: 'vector', maxzoom: 14 } },
    layers: [{ id: 'bg', type: 'background' }]
  }
  const fetchImpl: ProxyFetch = async () => new Response(JSON.stringify(upstreamStyle), { status: 200, headers: { 'content-type': 'application/json' } })
  registerTileRoutes(router, () => 'c:8080', fetchImpl, '/plugins/signalk-chart-locker')
  const res = new FakeRes()
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise((resolve) => res.on('finish', resolve))
  routes['/style/:source'](fakeReq('/style/basemap', { host: 'boat.local:3000' }), res as never)
  await done
  const body = JSON.parse(Buffer.concat(chunks).toString())
  assert.equal(body.sprite, 'http://boat.local:3000/plugins/signalk-chart-locker/style/basemap/sprite')
  assert.deepEqual(body.sources, upstreamStyle.sources)
  assert.equal(body.glyphs, upstreamStyle.glyphs)
  assert.deepEqual(body.layers, upstreamStyle.layers)
  assert.equal(res.outHeaders['content-type'], 'application/json')
  assert.equal(res.outHeaders['x-content-type-options'], 'nosniff')
})

test('the style route uses trusted Express origin fields and ignores raw forwarded headers', async () => {
  const { routes, router } = collectRoutes()
  const fetchImpl: ProxyFetch = async () => new Response(JSON.stringify({ sprite: 'https://up/ofm' }), { status: 200, headers: { 'content-type': 'application/json' } })
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const res = new FakeRes()
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise((resolve) => res.on('finish', resolve))
  const request = fakeReq('/style/basemap', { host: 'internal:3000', 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'attacker.example' })
  request.protocol = 'https'
  request.hostname = 'charts.example.com'
  routes['/style/:source'](request, res as never)
  await done
  const body = JSON.parse(Buffer.concat(chunks).toString())
  assert.equal(body.sprite, 'https://charts.example.com/plugins/signalk-chart-locker/style/basemap/sprite')
})

test('the style route relays a non-2xx upstream status without parsing', async () => {
  const { routes, router } = collectRoutes()
  const fetchImpl: ProxyFetch = async () => new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } })
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const res = new FakeRes()
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise((resolve) => res.on('finish', resolve))
  routes['/style/:source'](fakeReq('/style/basemap', { host: 'boat.local' }), res as never)
  await done
  assert.equal(res.statusCode, 502)
  assert.equal(Buffer.concat(chunks).toString(), 'bad gateway')
})

test('the style route rejects malformed, non-object, invalid-UTF-8, incorrectly typed, and partial documents', async () => {
  const invalidResponses = [
    () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200, headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { status: 206, headers: { 'content-type': 'application/json' } })
  ]

  for (const invalidResponse of invalidResponses) {
    const { routes, router } = collectRoutes()
    const fetchImpl: ProxyFetch = async () => invalidResponse()
    registerTileRoutes(router, () => 'c:8080', fetchImpl)
    const res = new FakeRes()
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    const done = new Promise((resolve) => res.on('finish', resolve))
    routes['/style/:source'](fakeReq('/style/basemap', { host: 'boat.local' }), res as never)
    await done
    assert.equal(res.statusCode, 502)
    assert.equal(Buffer.concat(chunks).length, 0)
  }
})

test('the style route rejects an oversized managed-container document', async () => {
  const { routes, router } = collectRoutes()
  const fetchImpl: ProxyFetch = async () => new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(5 * 1024 * 1024)
    }
  })
  registerTileRoutes(router, () => 'c:8080', fetchImpl)
  const res = new FakeRes()
  const done = new Promise((resolve) => res.on('finish', resolve))
  routes['/style/:source'](fakeReq('/style/basemap', { host: 'boat.local' }), res as never)
  await done
  assert.equal(res.statusCode, 502)
})
