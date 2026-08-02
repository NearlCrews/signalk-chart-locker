import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerAPI } from '@signalk/server-api'
import { registerRegionsRoutes } from '../src/http/regions-routes.js'
import { loadRegionsStore, saveRegionsStore, DEFAULT_REGIONS_STORE } from '../src/runtime/regions-store.js'
import { fakeApp, makeRegionsRouter, fakeRegionsRes } from './helpers.js'

const app = (): ServerAPI => fakeApp() as unknown as ServerAPI

/** A recording fetch that returns canned container responses keyed by URL suffix. */
function recordingFetch (responses: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }> = []
  const fetchImpl = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> => {
    calls.push({ url, init })
    const key = Object.keys(responses).find((k) => url.endsWith(k))
    const r = key ? responses[key]! : { status: 200, body: {} }
    // 204 and 304 are null-body statuses: a non-null body makes the Response constructor throw.
    const nullBody = r.status === 204 || r.status === 304
    return new Response(nullBody ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

test('POST /api/cache/config rejects a non-integer, a negative, and an over-range ttlDays', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { calls, fetchImpl } = recordingFetch({})
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl, getControlToken: () => 'control-secret' })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')!
  for (const bad of [3.5, -1, 366, 'x']) {
    const { responded, res } = fakeRegionsRes()
    await route.handler({ params: {}, body: { ttlDays: bad } }, res)
    assert.equal(responded[0]?.status, 400, `ttlDays ${String(bad)} must be rejected`)
  }
  assert.equal(calls.filter((c) => c.url.endsWith('/cache/scroll-ttl')).length, 0, 'no container call on a bad value')
})

test('POST /api/cache/config saves the store and posts ttlSecs to the container', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { calls, fetchImpl } = recordingFetch({ '/cache/scroll-ttl': { status: 204, body: {} } })
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl, getControlToken: () => 'control-secret' })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { ttlDays: 7 } }, res)
  assert.equal(responded[0]?.status, 204)
  assert.equal(loadRegionsStore(dataDir).cacheScrollTtlDays, 7)
  const call = calls.find((c) => c.url.endsWith('/cache/scroll-ttl'))
  assert.ok(call, 'posted to the container scroll-ttl route')
  assert.deepEqual(JSON.parse(call!.init!.body!), { ttlSecs: 7 * 86_400 })
  assert.equal(call?.init?.headers?.['x-tilecache-token'], 'control-secret')
})

test('POST /api/cache/config relays a container rejection instead of reporting success', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { fetchImpl } = recordingFetch({ '/cache/scroll-ttl': { status: 503, body: {} } })
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { ttlDays: 7 } }, res)
  assert.equal(responded[0]?.status, 503)
})

test('POST /api/cache/clear-scroll authenticates and relays the freed totals', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { calls, fetchImpl } = recordingFetch({ '/cache/clear-scroll': { status: 200, body: { freedBytes: 123, freedRows: 4 } } })
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl, getControlToken: () => 'control-secret' })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/clear-scroll')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: {} }, res)
  assert.equal(responded[0]?.status, 200)
  assert.deepEqual(responded[0]?.body, { freedBytes: 123, freedRows: 4 })
  assert.equal(calls[0]?.init?.headers?.['x-tilecache-token'], 'control-secret')
})

test('POST /api/cache/clear-scroll reports a container auth or server fault as a gateway failure', async () => {
  // A container 401 means the container rejected the plugin's own control token, and a container 500
  // or 502 means the container failed outright. Neither is anything the caller sent, so neither may
  // become the caller's status: on an /api route a 401 tells an integrator to check the Signal K
  // session. A 503 is deliberately excluded, and covered by the retry test below.
  for (const status of [401, 500, 502]) {
    const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
    const { router, routes } = makeRegionsRouter()
    registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
      dataDir,
      fetchImpl: async () => new Response(null, { status }),
      getControlToken: () => 'control-secret'
    })
    const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/clear-scroll')!
    const { responded, res } = fakeRegionsRes()
    await route.handler({ params: {}, body: {} }, res)
    // One status call: a second would mean the handler chose a status before it knew whether the body
    // could be read, and the last one wins on a real response.
    assert.deepEqual(
      responded,
      [{ status: 502, body: { error: 'tilecache request failed' } }],
      `a container ${status} must not become the caller's status`
    )
  }
})

test('POST /api/cache/config does not surface a container control-token rejection as the caller 401', async () => {
  // Predates the relay work: this route sets the status from the container directly. The container
  // gates /cache/scroll-ttl on the control token, so a stale container from an earlier install
  // answers 401 and the caller was told its own session had failed.
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async () => new Response(null, { status: 401 }),
    getControlToken: () => 'stale-token'
  })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { ttlDays: 7 } }, res)
  assert.equal(responded[0]?.status, 502)
  // The TTL is the plugin's own state and is persisted before the container call, so it survives.
  assert.equal(loadRegionsStore(dataDir).cacheScrollTtlDays, 7)
})

test('a busy container keeps its 503 and its retry hint instead of becoming a gateway failure', async () => {
  // The container's admission layer sheds a busy request with 503 and Retry-After, and it wraps every
  // route, so any forwarded call can shed. 503 is the one 5xx the caller can act on, by retrying, and
  // collapsing it into 502 would stop a client that retries on 503 and not on 502.
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const headers: Array<[string, string]> = []
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async () => new Response('tile cache is busy', { status: 503, headers: { 'retry-after': '1' } }),
    getControlToken: () => 'control-secret'
  })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/clear-scroll')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: {} }, { ...res, setHeader: (n, v) => headers.push([n, v]) })
  assert.equal(responded[0]?.status, 503, 'a shed request stays retryable')
  assert.deepEqual(headers, [['retry-after', '1']], "the container's own timing hint must survive the forward")
})

test('a malformed container retry hint is not forwarded to the caller', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const headers: Array<[string, string]> = []
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async () => new Response(null, { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } })
  })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/clear-scroll')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: {} }, { ...res, setHeader: (n, v) => headers.push([n, v]) })
  assert.equal(responded[0]?.status, 503, 'the status still relays')
  assert.deepEqual(headers, [], 'only the delay-seconds form the container emits is forwarded')
})

test('a container status that describes the caller request is still relayed', async () => {
  // The gateway rule must not swallow the documented client-facing statuses.
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async () => new Response(null, { status: 429 })
  })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/config')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: { ttlDays: 7 } }, res)
  assert.equal(responded[0]?.status, 429)
})

test('POST /api/cache/clear-scroll still reports 502 when a successful container response is malformed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', {
    dataDir,
    fetchImpl: async () => new Response('{ not json', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const route = routes.find(r => r.method === 'POST' && r.path === '/api/cache/clear-scroll')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: {} }, res)
  assert.equal(responded[0]?.status, 502)
  assert.deepEqual(responded[0]?.body, { error: 'tilecache returned a malformed response' })
})

test('GET /api/cache/stats merges ttlDays from the store and passes bySource through', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cache-route-'))
  saveRegionsStore(dataDir, { ...DEFAULT_REGIONS_STORE, cacheScrollTtlDays: 14 })
  const { fetchImpl } = recordingFetch({ '/cache/stats': { status: 200, body: { rows: 1, bytes: 2, cap: 3, bySource: [{ source: 's', bytes: 2, rows: 1 }], perSourceAvgBytes: {} } } })
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, app(), () => '127.0.0.1:9999', { dataDir, fetchImpl })
  const route = routes.find(r => r.method === 'GET' && r.path === '/api/cache/stats')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: null }, res)
  assert.equal(responded[0]?.status, 200)
  const body = responded[0]?.body as { ttlDays?: number; bySource?: unknown }
  assert.equal(body.ttlDays, 14)
  assert.deepEqual(body.bySource, [{ source: 's', bytes: 2, rows: 1 }])
})
