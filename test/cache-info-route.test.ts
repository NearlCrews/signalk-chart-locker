import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerAPI } from '@signalk/server-api'
import { registerCacheInfoRoute, type CacheInfoRouter, type CacheInfoRequest, type CacheInfoResponse } from '../src/http/cache-info-route.js'
import { fakeApp } from './helpers.js'

type Handler = (req: CacheInfoRequest, res: CacheInfoResponse) => void

function collector () {
  const routes = new Map<string, Handler>()
  const router: CacheInfoRouter = {
    get: (p, h) => routes.set(`GET ${p}`, h)
  }
  return { router, routes }
}

function fakeRes () {
  const out: { code: number, body?: unknown } = { code: 200 }
  const res: CacheInfoResponse = {
    status (c) { out.code = c; return res },
    json (v) { out.body = v }
  }
  return { res, out }
}

const securedApp = (): ServerAPI => fakeApp() as unknown as ServerAPI

test('cache-info reports free GiB and a recommended cap from injected statfs', () => {
  const { router, routes } = collector()
  // bsize 4096 * bavail 31457280 = 120 GiB free.
  registerCacheInfoRoute(router, securedApp(), { dataDir: '/data', statfs: () => ({ bsize: 4096, bavail: 31457280 }) })
  const { res, out } = fakeRes()
  routes.get('GET /api/cache-info')!({ params: {} }, res)
  assert.equal(out.code, 200)
  assert.deepEqual(out.body, { freeGiB: 120, recommendedCapGiB: 32, storage: 'data-directory', usingFallback: false })
})

test('cache-info falls back to nulls and the static default when statfs throws', () => {
  const { router, routes } = collector()
  registerCacheInfoRoute(router, securedApp(), { dataDir: '/data', statfs: () => { throw new Error('no statfs') } })
  const { res, out } = fakeRes()
  routes.get('GET /api/cache-info')!({ params: {} }, res)
  assert.equal(out.code, 200)
  assert.deepEqual(out.body, { freeGiB: null, recommendedCapGiB: 8, storage: 'unknown', usingFallback: false })
})

test('cache-info measures the configured external path and reports a missing-drive fallback', () => {
  const { router, routes } = collector()
  const paths: string[] = []
  registerCacheInfoRoute(router, securedApp(), {
    dataDir: '/data',
    cachePath: () => '/media/cache',
    statfs: (path) => {
      paths.push(path)
      if (path === '/media/cache') throw new Error('drive absent')
      return { bsize: 4096, bavail: 2_621_440 }
    }
  })
  const { res, out } = fakeRes()
  routes.get('GET /api/cache-info')!({ params: {} }, res)
  assert.deepEqual(paths, ['/media/cache', '/data'])
  assert.deepEqual(out.body, { freeGiB: 10, recommendedCapGiB: 4, storage: 'data-directory', usingFallback: true })
})

test('cache-info is not mounted without a security strategy (fail closed)', () => {
  const { router, routes } = collector()
  const app = { error: () => {} } as unknown as ServerAPI
  assert.equal(registerCacheInfoRoute(router, app), false)
  assert.equal(routes.size, 0)
})
