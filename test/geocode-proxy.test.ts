import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPrewarmRoutes, type PrewarmRouter, type PrewarmRequest, type PrewarmResponse } from '../src/http/prewarm-routes.js'
import type { ServerAPI } from '@signalk/server-api'

interface FullRequest extends PrewarmRequest {
  query?: Record<string, string>
}

/** A minimal app that satisfies both ensureApiAdminGate and the getDataDirPath call in registerPrewarmRoutes. */
const securedApp = (): ServerAPI => {
  const dir = mkdtempSync(join(tmpdir(), 'geocode-test-'))
  return {
    error: () => {},
    getDataDirPath: () => dir,
    securityStrategy: { addAdminMiddleware: () => {} }
  } as unknown as ServerAPI
}

function makeRouter (): { calls: Array<{ method: string; path: string; handler: (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }>; router: PrewarmRouter } {
  const calls: Array<{ method: string; path: string; handler: (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }> = []
  return {
    calls,
    router: {
      get (path, handler) { calls.push({ method: 'GET', path, handler: handler as (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }) },
      post (path, handler) { calls.push({ method: 'POST', path, handler: handler as (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }) },
      delete (path, handler) { calls.push({ method: 'DELETE', path, handler: handler as (req: FullRequest, res: PrewarmResponse) => void | Promise<void> }) }
    }
  }
}

test('registerPrewarmRoutes mounts GET /api/geocode', () => {
  const { router, calls } = makeRouter()
  registerPrewarmRoutes(router, securedApp(), () => '127.0.0.1:9999')
  assert.ok(calls.some(c => c.method === 'GET' && c.path === '/api/geocode'), 'geocode route must be mounted')
})

test('GET /api/geocode proxies lat and lon to the container and returns the response', async () => {
  const fetched: string[] = []
  const fetchImpl = async (url: string) => {
    fetched.push(url)
    return new Response(JSON.stringify({ display_name: 'Test City' }), { status: 200 })
  }
  const { router, calls } = makeRouter()
  registerPrewarmRoutes(router, securedApp(), () => '127.0.0.1:9999', { fetchImpl })
  const route = calls.find(c => c.path === '/api/geocode')!
  const responded: Array<{ status: number; body: unknown }> = []
  const res: PrewarmResponse = {
    status (code) { responded.push({ status: code, body: null }); return res },
    json (body) { if (responded.length) responded[responded.length - 1].body = body },
    end () {}
  }
  await route.handler({ params: {}, body: null, query: { lat: '37.77', lon: '-122.41' } }, res)
  assert.ok(fetched.length === 1, 'exactly one upstream fetch')
  assert.ok(fetched[0].includes('lat=37.77'), 'lat forwarded')
  assert.ok(fetched[0].includes('lon=-122.41'), 'lon forwarded')
  assert.equal(responded[0]?.status, 200)
  assert.deepEqual(responded[0]?.body, { display_name: 'Test City' }, 'proxied body relayed to caller')
})

test('GET /api/geocode returns 400 when lat or lon is missing', async () => {
  const fetchImpl = async () => new Response('{}', { status: 200 })
  const { router, calls } = makeRouter()
  registerPrewarmRoutes(router, securedApp(), () => '127.0.0.1:9999', { fetchImpl })
  const route = calls.find(c => c.path === '/api/geocode')!
  const responded: Array<{ status: number }> = []
  const res: PrewarmResponse = {
    status (code) { responded.push({ status: code }); return res },
    json () {},
    end () {}
  }
  await route.handler({ params: {}, body: null, query: {} }, res)
  assert.equal(responded[0]?.status, 400, 'both absent must be 400')
  await route.handler({ params: {}, body: null, query: { lon: '-122.41' } }, res)
  assert.equal(responded[1]?.status, 400, 'missing lat must be 400')
  await route.handler({ params: {}, body: null, query: { lat: '37.77' } }, res)
  assert.equal(responded[2]?.status, 400, 'missing lon must be 400')
})
