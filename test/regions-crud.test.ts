import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerAPI } from '@signalk/server-api'
import { registerRegionsRoutes } from '../src/http/regions-routes.js'
import { fakeApp, makeRegionsRouter, fakeRegionsRes } from './helpers.js'

/** The Recorder fake carries the slice registerRegionsRoutes reads (securityStrategy, getDataDirPath). */
const app = (): ServerAPI => fakeApp() as unknown as ServerAPI
const WARM_BOOT_ID = '0123456789abcdef0123456789abcdef'
const warmJobId = (counter: number): string => `warm-${WARM_BOOT_ID}-${counter}`

test('registerRegionsRoutes mounts all region routes', () => {
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999')
  const paths = routes.map(r => `${r.method} ${r.path}`)
  assert.ok(paths.includes('GET /api/regions'), 'GET /api/regions must be mounted')
  assert.ok(paths.includes('POST /api/regions'), 'POST /api/regions must be mounted')
  assert.ok(paths.some(p => p.startsWith('DELETE /api/regions/')), 'DELETE /api/regions/:id must be mounted')
  assert.ok(paths.some(p => p.includes('/api/regions/') && p.includes('status')), 'GET /api/regions/:id/status must be mounted')
  assert.ok(paths.some(p => p.includes('/api/regions/') && p.includes('redownload')), 'POST /api/regions/:id/redownload must be mounted')
})

test('POST /api/regions refuses an invalid bbox with 400', async () => {
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => null, { dataDir })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { bbox: 'not-an-array', sourceIds: [], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
  assert.equal(responded[0]?.status, 400, 'invalid bbox must yield 400')
})

test('POST /api/regions rejects invalid sources, zooms, coordinates, and names before container access', async () => {
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => null, { dataDir })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const valid = { bbox: [-10, 50, 10, 60], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' }
  for (const body of [
    { ...valid, sourceIds: [] },
    { ...valid, sourceIds: ['source', 'source'] },
    { ...valid, sourceIds: ['does-not-exist'] },
    { ...valid, minzoom: 1.5 },
    { ...valid, maxzoom: 25 },
    { ...valid, bbox: [-181, 50, 10, 60] },
    { ...valid, bbox: [-10, 50, 181, 60] },
    { ...valid, bbox: [10, 50, 10, 60] },
    { ...valid, bbox: [180, 50, -180, 60] },
    { ...valid, name: 'bad\nname' },
    { ...valid, name: 'bad\u0085name' },
    { ...valid, name: 'bad\u2028name' },
    { ...valid, name: 'x'.repeat(121) }
  ]) {
    const { responded, res } = fakeRegionsRes()
    await route.handler({ params: {}, body }, res)
    assert.equal(responded[0]?.status, 400)
  }
})

test('POST /api/regions accepts an antimeridian-crossing bbox', async () => {
  let warmBody: unknown
  const fetchImpl = async (url: string, init?: { body?: string }) => {
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({ regionsFreeBytes: 2_000_000_000, perSourceAvgBytes: { seamark: 1 } }), { status: 200 })
    }
    if (url.endsWith('/warm')) {
      warmBody = JSON.parse(init?.body ?? '{}')
      return Response.json({ jobId: warmJobId(1) })
    }
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  const bbox = [170, -10, -170, 10]
  await route.handler({ params: {}, body: { bbox, sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Date line' } }, res)
  assert.equal(responded[0]?.status, 200)
  assert.deepEqual((warmBody as { bbox: number[] }).bbox, bbox)
  assert.equal((responded[0]?.body as { region: { cachedBytes: number } }).region.cachedBytes, 0)
})

test('POST /api/regions returns 502 for malformed container statistics', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({ regionsFreeBytes: 2_000_000_000, perSourceAvgBytes: { seamark: -1 } }), { status: 200 })
    }
    throw new Error(`warm must not be called for an invalid estimate: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { bbox: [-1, -1, 1, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' } }, res)
  assert.equal(responded[0]?.status, 502)
  assert.deepEqual(responded[0]?.body, { error: 'tilecache returned malformed statistics' })
})

test('POST /api/regions returns 502 for oversized container statistics', async () => {
  const fetchImpl = async () => new Response('{}', {
    status: 200,
    headers: { 'content-length': String(5 * 1024 * 1024) }
  })
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({
    params: {},
    body: { bbox: [-1, -1, 1, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' }
  }, res)
  assert.equal(responded[0]?.status, 502)
  assert.deepEqual(responded[0]?.body, { error: 'tilecache returned malformed statistics' })
})

test('POST /api/regions returns 503 when the container address is unavailable', async () => {
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => null, { dataDir })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
  assert.equal(responded[0]?.status, 503, 'missing container address must yield 503')
})

test('an invalid container job id is not retained or used in a status URL', async () => {
  const calls: string[] = []
  const invalidJobId = `bad\n${'x'.repeat(80)}`
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url)
    if (url.includes('/cache/stats')) return Response.json({ regionsFreeBytes: 1_000_000, perSourceAvgBytes: { seamark: 1 } })
    if (url.endsWith('/warm')) return Response.json({ jobId: invalidJobId })
    if (url.includes('/warm/region/')) return new Response(null, { status: 404 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const create = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: createRes } = fakeRegionsRes()
  await create.handler({ params: {}, body: { bbox: [-1, -1, 1, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' } }, createRes)
  assert.equal(created[0]?.status, 202)
  const createdRegion = (created[0]?.body as { region: { id: string, cachedBytes: number } }).region
  assert.equal(createdRegion.cachedBytes, 0)
  const id = createdRegion.id
  const status = routes.find(r => r.method === 'GET' && r.path.endsWith('/status'))!
  await status.handler({ params: { id }, body: null }, fakeRegionsRes().res)
  assert.equal(calls.some((url) => url.includes(`/warm/${encodeURIComponent(invalidJobId)}`)), false)
  assert.equal(calls.some((url) => url.includes('/warm/region/')), true)
})

test('the status route rejects an unknown durable region before container lookup', async () => {
  let fetches = 0
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async () => { fetches++; throw new Error('must not fetch') }
  })
  const status = routes.find(r => r.method === 'GET' && r.path.endsWith('/status'))!
  const { responded, res } = fakeRegionsRes()
  await status.handler({ params: { id: 'missing' }, body: null }, res)
  assert.equal(responded[0]?.status, 404)
  assert.equal(fetches, 0)
})

test('GET /api/regions returns the persisted regions list', async () => {
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  const calls: string[] = []
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async (url) => {
      calls.push(url)
      return new Response(JSON.stringify({ regions: {} }), { status: 200 })
    }
  })
  const route = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: null }, res)
  assert.equal(responded[0]?.status, 200)
  assert.ok(Array.isArray(responded[0]?.body), 'body must be an array')
  assert.equal(calls.length, 1, 'the list uses one batched container request')
  assert.ok(calls[0]?.endsWith('/cache/regions'))
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
        perSourceAvgBytes: { 'depth-gebco': 1 }
      }), { status: 200 })
    }
    throw new Error(`warm must not be called when over budget: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
  assert.equal(responded[0]?.status, 400, 'an over-budget estimate must be refused with 400')
  // Nothing persisted.
  const getRoute = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRegionsRes()
  await getRoute.handler({ params: {}, body: null }, listRes)
  assert.equal((listed[0]?.body as unknown[]).length, 0, 'an over-budget region must not be persisted')
})

test('a warm-relay failure leaves no persisted region', async () => {
  // The budget fits, so the POST gets past the gate and persists the region, but the container rejects
  // the warm start: the route must drop the just-added region and relay 503, never leave it stuck at
  // downloading with no job.
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({
        rows: 0,
        bytes: 0,
        cap: 4_000_000_000,
        pinnedBytes: 0,
        scrollBytes: 0,
        regionsBudgetBytes: 2_000_000_000,
        regionsFreeBytes: 2_000_000_000,
        perSourceAvgBytes: { 'depth-gebco': 1 }
      }), { status: 200 })
    }
    if (url.endsWith('/warm')) return new Response(JSON.stringify({ error: 'busy' }), { status: 503 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const post = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded, res } = fakeRegionsRes()
  await post.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, res)
  assert.equal(responded[0]?.status, 503, 'a rejected warm start must preserve the container status')
  assert.deepEqual(responded[0]?.body, { error: 'busy' })
  const list = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRegionsRes()
  await list.handler({ params: {}, body: null }, listRes)
  assert.equal((listed[0]?.body as unknown[]).length, 0, 'a failed warm start must not leave a persisted region')
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
        perSourceAvgBytes: { 'depth-gebco': 1 }
      }), { status: 200 })
    }
    if (/\/warm\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ total: 1, done: 1, skipped: 0, bytes: 100, errors: 0, state: 'done' }), { status: 200 })
    }
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(1) })
    if (url.includes('/cache/region/')) return new Response(JSON.stringify({ bytes: 100 }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const post = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: postRes } = fakeRegionsRes()
  await post.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Test' } }, postRes)
  assert.equal(created[0]?.status, 200)
  const region = (created[0]?.body as { region: { id: string; status: string } }).region
  assert.equal(region.status, 'downloading')
  // Poll the status: the terminal 'done' snapshot must reconcile the persisted region to 'ready'.
  const status = routes.find(r => r.method === 'GET' && r.path.includes('/api/regions/') && r.path.includes('status'))!
  const { res: statusRes } = fakeRegionsRes()
  await status.handler({ params: { id: region.id }, body: null }, statusRes)
  const list = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRegionsRes()
  await list.handler({ params: {}, body: null }, listRes)
  const persisted = (listed[0]?.body as Array<{ id: string; status: string }>).find(r => r.id === region.id)!
  assert.equal(persisted.status, 'ready', 'a done job reconciles the region to ready, never stuck at downloading')
})

test('a done snapshot with tile errors never marks a region ready', async () => {
  const stats = { regionsFreeBytes: 2_000_000_000, perSourceAvgBytes: { seamark: 1 } }
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) return new Response(JSON.stringify(stats), { status: 200 })
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(2) })
    if (/\/warm\/[^/]+$/.test(url)) return new Response(JSON.stringify({ total: 2, done: 1, skipped: 1, bytes: 100, errors: 1, state: 'done' }), { status: 200 })
    if (url.includes('/cache/region/')) return new Response(JSON.stringify({ bytes: 100 }), { status: 200 })
    if (url.includes('/cache/regions')) return new Response(JSON.stringify({ regions: {} }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const create = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: createRes } = fakeRegionsRes()
  await create.handler({ params: {}, body: { bbox: [-1, -1, 1, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' } }, createRes)
  const id = (created[0]?.body as { region: { id: string } }).region.id
  const status = routes.find(r => r.method === 'GET' && r.path.endsWith('/status'))!
  await status.handler({ params: { id }, body: null }, fakeRegionsRes().res)
  const { loadRegionsStore } = await import('../src/runtime/regions-store.js')
  assert.equal(loadRegionsStore(dataDir).regions[0]?.status, 'error')
})

test('the status route rejects a malformed successful container snapshot', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) return new Response(JSON.stringify({ regionsFreeBytes: 2_000_000_000, perSourceAvgBytes: { seamark: 1 } }), { status: 200 })
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(3) })
    if (/\/warm\/[^/]+$/.test(url)) return new Response(JSON.stringify({ state: 'done', errors: 'one' }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const create = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: createRes } = fakeRegionsRes()
  await create.handler({ params: {}, body: { bbox: [-1, -1, 1, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' } }, createRes)
  const id = (created[0]?.body as { region: { id: string } }).region.id
  const status = routes.find(r => r.method === 'GET' && r.path.endsWith('/status'))!
  const { responded, res } = fakeRegionsRes()
  await status.handler({ params: { id }, body: null }, res)
  assert.equal(responded[0]?.status, 502)
})

test('the status route rejects an incomplete done snapshot even when it reports errors', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) return new Response(JSON.stringify({ regionsFreeBytes: 1_000_000, perSourceAvgBytes: { seamark: 1 } }), { status: 200 })
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(4) })
    if (/\/warm\/[^/]+$/.test(url)) return new Response(JSON.stringify({ total: 2, done: 1, skipped: 0, bytes: 100, errors: 1, state: 'done' }), { status: 200 })
    throw new Error(`unexpected ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const create = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: createRes } = fakeRegionsRes()
  await create.handler({ params: {}, body: { bbox: [-1, -1, 1, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' } }, createRes)
  const id = (created[0]?.body as { region: { id: string } }).region.id
  const status = routes.find(r => r.method === 'GET' && r.path.endsWith('/status'))!
  const { responded, res } = fakeRegionsRes()
  await status.handler({ params: { id }, body: null }, res)
  assert.equal(responded[0]?.status, 502)
})

test('a rejected re-download relays the status and leaves the region state unchanged', async () => {
  let warmStarts = 0
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({ regionsFreeBytes: 2_000_000_000, perSourceAvgBytes: { seamark: 1 } }), { status: 200 })
    }
    if (url.endsWith('/warm')) {
      warmStarts++
      return warmStarts === 1
        ? Response.json({ jobId: warmJobId(1) })
        : new Response(JSON.stringify({ error: 'too many jobs' }), { status: 429 })
    }
    if (url.includes('/cache/regions')) return new Response(JSON.stringify({ regions: {} }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const create = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: createRes } = fakeRegionsRes()
  await create.handler({ params: {}, body: { bbox: [-1, -1, 1, 1], sourceIds: ['seamark'], minzoom: 1, maxzoom: 2, name: 'Area' } }, createRes)
  const id = (created[0]!.body as { region: { id: string } }).region.id
  const { loadRegionsStore, updateRegion } = await import('../src/runtime/regions-store.js')
  updateRegion(dataDir, id, { status: 'ready' })

  const redownload = routes.find(r => r.method === 'POST' && r.path.endsWith('/redownload'))!
  const { responded, res } = fakeRegionsRes()
  await redownload.handler({ params: { id }, body: null }, res)
  assert.equal(responded[0]?.status, 429)

  assert.equal(loadRegionsStore(dataDir).regions[0]?.status, 'ready')
})

test('saving position-warm settings preserves saved regions', async () => {
  // The interleave regression: save a region, then save position-warm settings. The settings save must
  // merge ONLY positionWarm into the store, never rewrite the legacy box shape that wiped regions.
  const fetchImpl = async (url: string) => {
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({
        rows: 0,
        bytes: 0,
        cap: 4_000_000_000,
        pinnedBytes: 0,
        scrollBytes: 0,
        regionsBudgetBytes: 2_000_000_000,
        regionsFreeBytes: 2_000_000_000,
        perSourceAvgBytes: { 'depth-gebco': 1 }
      }), { status: 200 })
    }
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(1) })
    if (url.includes('/cache/region/')) return new Response(JSON.stringify({ bytes: 0 }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })

  // Save a region.
  const post = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: postRes } = fakeRegionsRes()
  await post.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Bay' } }, postRes)
  assert.equal(created[0]?.status, 200)
  const regionId = (created[0]?.body as { region: { id: string } }).region.id

  // Save position-warm settings (the toggle that used to wipe all saved regions).
  const postCfg = routes.find(r => r.method === 'POST' && r.path === '/api/position-warm/config')!
  const { responded: cfgSaved, res: cfgRes } = fakeRegionsRes()
  await postCfg.handler({ params: {}, body: { positionWarm: { enabled: true, sources: ['seamark'] } } }, cfgRes)
  assert.equal(cfgSaved[0]?.status, 204)

  // The region must still be present after the settings save.
  const list = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRegionsRes()
  await list.handler({ params: {}, body: null }, listRes)
  const persisted = (listed[0]?.body as Array<{ id: string }>).find(r => r.id === regionId)
  assert.ok(persisted, 'saving position-warm settings must not drop the saved region')

  // And the position-warm settings must have been updated.
  const getCfg = routes.find(r => r.method === 'GET' && r.path === '/api/position-warm/config')!
  const { responded: cfg, res: getCfgRes } = fakeRegionsRes()
  await getCfg.handler({ params: {}, body: null }, getCfgRes)
  const pw = cfg[0]?.body as { enabled: boolean; sources: string[] }
  assert.equal(pw.enabled, true, 'position-warm enabled must be persisted')
  assert.deepEqual(pw.sources, ['seamark'], 'position-warm sources must be persisted')
})

test('DELETE /api/regions/:id removes the region after the container delete succeeds', async () => {
  const controlHeaders: Array<Record<string, string> | undefined> = []
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    if (init?.method === 'DELETE' || (url.endsWith('/warm') && init?.method === 'POST')) controlHeaders.push(init.headers)
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({
        rows: 0,
        bytes: 0,
        cap: 4_000_000_000,
        pinnedBytes: 0,
        scrollBytes: 0,
        regionsBudgetBytes: 2_000_000_000,
        regionsFreeBytes: 2_000_000_000,
        perSourceAvgBytes: { 'depth-gebco': 1 }
      }), { status: 200 })
    }
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(1) })
    if (url.includes('/cache/region/')) return new Response(JSON.stringify({ bytes: 0 }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl, getControlToken: () => 'control-secret' })
  const post = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: postRes } = fakeRegionsRes()
  await post.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Bay' } }, postRes)
  const regionId = (created[0]?.body as { region: { id: string } }).region.id

  const del = routes.find(r => r.method === 'DELETE' && r.path.startsWith('/api/regions/'))!
  const { responded: deleted, res: delRes } = fakeRegionsRes()
  await del.handler({ params: { id: regionId }, body: null }, delRes)
  assert.equal(deleted[0]?.status, 204, 'a successful container delete returns 204')
  assert.equal(controlHeaders.length, 2)
  assert.ok(controlHeaders.every((headers) => headers?.['x-tilecache-token'] === 'control-secret'))

  const list = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRegionsRes()
  await list.handler({ params: {}, body: null }, listRes)
  assert.equal((listed[0]?.body as unknown[]).length, 0, 'the region is removed once the container delete succeeds')
})

test('DELETE /api/regions/:id returns 503 and keeps the region when the container is unreachable', async () => {
  // The container delete must run FIRST. If it is unreachable, the region stays in the store so the
  // user can retry: removing it first would orphan its region_tiles pins and shrink regionsFreeBytes.
  const fetchImpl = async (url: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') throw new Error('container down')
    if (url.includes('/cache/stats')) {
      return new Response(JSON.stringify({
        rows: 0,
        bytes: 0,
        cap: 4_000_000_000,
        pinnedBytes: 0,
        scrollBytes: 0,
        regionsBudgetBytes: 2_000_000_000,
        regionsFreeBytes: 2_000_000_000,
        perSourceAvgBytes: { 'depth-gebco': 1 }
      }), { status: 200 })
    }
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(1) })
    if (url.includes('/cache/region/')) return new Response(JSON.stringify({ bytes: 0 }), { status: 200 })
    throw new Error(`unexpected url: ${url}`)
  }
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const post = routes.find(r => r.method === 'POST' && r.path === '/api/regions')!
  const { responded: created, res: postRes } = fakeRegionsRes()
  await post.handler({ params: {}, body: { bbox: [-10.0, 50.0, 10.0, 60.0], sourceIds: ['depth-gebco'], minzoom: 6, maxzoom: 12, name: 'Bay' } }, postRes)
  const regionId = (created[0]?.body as { region: { id: string } }).region.id

  const del = routes.find(r => r.method === 'DELETE' && r.path.startsWith('/api/regions/'))!
  const { responded: deleted, res: delRes } = fakeRegionsRes()
  await del.handler({ params: { id: regionId }, body: null }, delRes)
  assert.equal(deleted[0]?.status, 503, 'an unreachable container yields 503')

  const list = routes.find(r => r.method === 'GET' && r.path === '/api/regions')!
  const { responded: listed, res: listRes } = fakeRegionsRes()
  await list.handler({ params: {}, body: null }, listRes)
  const persisted = (listed[0]?.body as Array<{ id: string }>).find(r => r.id === regionId)
  assert.ok(persisted, 'the region remains in the store when the container delete fails')
})

test('DELETE /api/regions/:id returns 404 for an unknown region without container access', async () => {
  let calls = 0
  const { router, routes } = makeRegionsRouter()
  const dataDir = mkdtempSync(join(tmpdir(), 'region-route-test-'))
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async () => { calls++; throw new Error('must not be called') }
  })
  const del = routes.find(r => r.method === 'DELETE' && r.path.startsWith('/api/regions/'))!
  const { responded, res } = fakeRegionsRes()
  await del.handler({ params: { id: 'missing' }, body: null }, res)
  assert.equal(responded[0]?.status, 404)
  assert.equal(calls, 0)
})
