import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerAPI } from '@signalk/server-api'
import { registerPrewarmRoutes, type PrewarmRouter, type PrewarmResponse } from '../src/http/prewarm-routes.js'
import { fakeApp } from './helpers.js'

/** The Recorder fake carries the slice registerPrewarmRoutes reads (securityStrategy, getDataDirPath). */
const app = (): ServerAPI => fakeApp() as unknown as ServerAPI

function makeRouter () {
  const routes: Array<{ method: string; path: string; handler: Function }> = []
  const router: PrewarmRouter = {
    get (path, handler) { routes.push({ method: 'GET', path, handler }) },
    post (path, handler) { routes.push({ method: 'POST', path, handler }) },
    delete (path, handler) { routes.push({ method: 'DELETE', path, handler }) }
  }
  return { routes, router }
}

function fakeRes (): { responded: Array<{ status: number; body: unknown }>; res: PrewarmResponse } {
  const responded: Array<{ status: number; body: unknown }> = []
  const res: PrewarmResponse = {
    status (code) { responded.push({ status: code, body: null }); return res },
    json (body) { if (responded.length) responded[responded.length - 1].body = body },
    end () { if (responded.length) responded[responded.length - 1].body = null }
  }
  return { responded, res }
}

test('registerPrewarmRoutes mounts all region routes', () => {
  const { router, routes } = makeRouter()
  registerPrewarmRoutes(router, app(), () => '127.0.0.1:9999')
  const paths = routes.map(r => `${r.method} ${r.path}`)
  assert.ok(paths.includes('GET /api/regions'), 'GET /api/regions must be mounted')
  assert.ok(paths.includes('POST /api/regions'), 'POST /api/regions must be mounted')
  assert.ok(paths.some(p => p.startsWith('DELETE /api/regions/')), 'DELETE /api/regions/:id must be mounted')
  assert.ok(paths.some(p => p.includes('/api/regions/') && p.includes('status')), 'GET /api/regions/:id/status must be mounted')
  assert.ok(paths.some(p => p.includes('/api/regions/') && p.includes('redownload')), 'POST /api/regions/:id/redownload must be mounted')
})

test('POST /api/regions refuses an invalid bbox with 400', async () => {
  const { router, routes } = makeRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerPrewarmRoutes(router, app(), () => null, { dataDir })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRes()
  await route.handler({ params: {}, body: { bbox: 'not-an-array', sourceIds: [], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
  assert.equal(responded[0]?.status, 400, 'invalid bbox must yield 400')
})

test('POST /api/regions returns 503 when the container address is unavailable', async () => {
  const { router, routes } = makeRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerPrewarmRoutes(router, app(), () => null, { dataDir })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRes()
  await route.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
  assert.equal(responded[0]?.status, 503, 'missing container address must yield 503')
})

test('GET /api/regions returns the persisted regions list', async () => {
  const { router, routes } = makeRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerPrewarmRoutes(router, app(), () => '127.0.0.1:9999', { dataDir })
  const route = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded, res } = fakeRes()
  await route.handler({ params: {}, body: null }, res)
  assert.equal(responded[0]?.status, 200)
  assert.ok(Array.isArray(responded[0]?.body), 'body must be an array')
})

test('POST /api/regions returns 400 when the estimate exceeds the regions-free budget', async () => {
  // Stats report zero free room, so any non-empty estimate must be refused server-side, upfront,
  // before the region is persisted or the warm job starts.
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({
        rows: 0,
        bytes: 0,
        cap: 1_000_000_000,
        pinnedBytes: 0,
        scrollBytes: 0,
        regionsBudgetBytes: 0,
        regionsFreeBytes: 0,
        perSourceAvgBytes: {}
      }), { status: 200 })
    }
    throw new Error(`warm must not be called when over budget: ${url}`)
  }
  const { router, routes } = makeRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerPrewarmRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRes()
  await route.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
  assert.equal(responded[0]?.status, 400, 'an over-budget estimate must be refused with 400')
  // Nothing persisted.
  const getRoute = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRes()
  await getRoute.handler({ params: {}, body: null }, listRes)
  assert.equal((listed[0]?.body as unknown[]).length, 0, 'an over-budget region must not be persisted')
})

test('a terminal job snapshot reconciles the region status away from downloading', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) {
      // A budget large enough that this region's upfront estimate fits, so the POST succeeds (200) and
      // the test can then drive the status reconcile. (The over-budget refusal is covered separately.)
      return new Response(JSON.stringify({
        rows: 0,
        bytes: 0,
        cap: 4_000_000_000,
        pinnedBytes: 0,
        scrollBytes: 0,
        regionsBudgetBytes: 2_000_000_000,
        regionsFreeBytes: 2_000_000_000,
        perSourceAvgBytes: {}
      }), { status: 200 })
    }
    if (/\/warm\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ total: 1, done: 1, skipped: 0, bytes: 100, errors: 0, state: 'done' }), { status: 200 })
    }
    if (url.endsWith('/warm')) return new Response(JSON.stringify({ jobId: 'warm-1' }), { status: 200 })
    if (url.includes('/cache/region/')) return new Response(JSON.stringify({ bytes: 100 }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerPrewarmRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const post = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: postRes } = fakeRes()
  await post.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, postRes)
  assert.equal(created[0]?.status, 200)
  const region = (created[0]?.body as { region: { id: string; status: string } }).region
  assert.equal(region.status, 'downloading')
  // Poll the status: the terminal 'done' snapshot must reconcile the persisted region to 'ready'.
  const status = routes.find(r => r.method === 'GET' && r.path.includes('/api/regions/') && r.path.includes('status'))!
  const { res: statusRes } = fakeRes()
  await status.handler({ params: { id: region.id }, body: null }, statusRes)
  const list = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRes()
  await list.handler({ params: {}, body: null }, listRes)
  const persisted = (listed[0]?.body as Array<{ id: string; status: string }>).find(r => r.id === region.id)!
  assert.equal(persisted.status, 'ready', 'a done job reconciles the region to ready, never stuck at downloading')
})
