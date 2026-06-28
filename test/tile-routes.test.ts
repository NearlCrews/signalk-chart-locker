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

function fakeReq (url: string, headers: Record<string, string> = {}): ProxyRequest & { triggerClose: () => void } {
  let closeCb: () => void = () => {}
  return { url, headers, on (_e, cb) { closeCb = cb }, triggerClose () { closeCb() } }
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

test('a tile request with no tilecache address returns 503', async () => {
  const { routes, router } = collectRoutes()
  registerTileRoutes(router, () => null)
  const res = new FakeRes()
  routes[tilePath](fakeReq('/tile/s/1/0/0'), res as never)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.statusCode, 503)
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
  req.triggerClose()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(aborted, true)
})
