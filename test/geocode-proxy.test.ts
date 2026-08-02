import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRegionsRoutes } from '../src/http/regions-routes.js'
import type { ServerAPI } from '@signalk/server-api'
import { fakeApp, makeRegionsRouter, fakeRegionsRes } from './helpers.js'

const securedApp = (): ServerAPI => fakeApp() as unknown as ServerAPI

test('registerRegionsRoutes mounts GET /api/geocode', () => {
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, securedApp(), () => '127.0.0.1:9999')
  assert.ok(routes.some(c => c.method === 'GET' && c.path === '/api/geocode'), 'geocode route must be mounted')
})

test('GET /api/geocode proxies lat and lon to the container and returns the response', async () => {
  const fetched: string[] = []
  const fetchImpl = async (url: string) => {
    fetched.push(url)
    return new Response(JSON.stringify({ display_name: 'Test City' }), { status: 200 })
  }
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, securedApp(), () => '127.0.0.1:9999', { fetchImpl })
  const route = routes.find(c => c.path === '/api/geocode')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: null, query: { lat: '37.77', lon: '-122.41' } }, res)
  assert.ok(fetched.length === 1, 'exactly one upstream fetch')
  assert.ok(fetched[0].includes('lat=37.77'), 'lat forwarded')
  assert.ok(fetched[0].includes('lon=-122.41'), 'lon forwarded')
  assert.equal(responded[0]?.status, 200)
  assert.deepEqual(responded[0]?.body, { display_name: 'Test City' }, 'proxied body relayed to caller')
})

test('GET /api/geocode returns 400 when lat or lon is missing', async () => {
  const fetchImpl = async () => new Response('{}', { status: 200 })
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, securedApp(), () => '127.0.0.1:9999', { fetchImpl })
  const route = routes.find(c => c.path === '/api/geocode')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: null, query: {} }, res)
  assert.equal(responded[0]?.status, 400, 'both absent must be 400')
  await route.handler({ params: {}, body: null, query: { lon: '-122.41' } }, res)
  assert.equal(responded[1]?.status, 400, 'missing lat must be 400')
  await route.handler({ params: {}, body: null, query: { lat: '37.77' } }, res)
  assert.equal(responded[2]?.status, 400, 'missing lon must be 400')
})

test('GET /api/geocode relays the documented container statuses when the body is empty', async () => {
  // The container answers an invalid point with 400, a disabled or unknown geocode endpoint with 404,
  // and an unreachable provider with 502, each as a bare status with no body. docs/API.md documents
  // those statuses on this route, so they must reach the caller rather than collapsing into one 502.
  for (const status of [400, 404, 502]) {
    const { router, routes } = makeRegionsRouter()
    registerRegionsRoutes(router, securedApp(), () => '127.0.0.1:9999', {
      fetchImpl: async () => new Response(null, { status })
    })
    const route = routes.find(c => c.path === '/api/geocode')!
    const { responded, res } = fakeRegionsRes()
    await route.handler({ params: {}, body: null, query: { lat: '37.77', lon: '-122.41' } }, res)
    // One status call, carrying the container status: a second call would mean the handler chose a
    // status before it knew whether the body could be read, and the last one wins on a real response.
    assert.deepEqual(
      responded,
      [{ status, body: { error: 'tilecache request failed' } }],
      `a bodyless container ${status} must be relayed`
    )
  }
})

test('GET /api/geocode reports 502 when a successful container response is malformed', async () => {
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, securedApp(), () => '127.0.0.1:9999', {
    fetchImpl: async () => new Response('{ not json', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const route = routes.find(c => c.path === '/api/geocode')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: null, query: { lat: '37.77', lon: '-122.41' } }, res)
  assert.equal(responded[0]?.status, 502)
  assert.deepEqual(responded[0]?.body, { error: 'tilecache returned a malformed response' })
})

test('GET /api/geocode returns 404 without egress when geocoding is disabled', async () => {
  let calls = 0
  const { router, routes } = makeRegionsRouter()
  registerRegionsRoutes(router, securedApp(), () => '127.0.0.1:9999', {
    isGeocodingEnabled: () => false,
    fetchImpl: async () => { calls++; return new Response('{}') }
  })
  const route = routes.find(c => c.path === '/api/geocode')!
  const { responded, res } = fakeRegionsRes()
  await route.handler({ params: {}, body: null, query: { lat: '1', lon: '2' } }, res)
  assert.equal(responded[0]?.status, 404)
  assert.equal(calls, 0)
})
