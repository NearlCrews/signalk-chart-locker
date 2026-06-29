import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRegionsRoutes, type RegionsRouter, type RegionsRequest, type RegionsResponse } from '../src/http/regions-routes.js'
import type { ServerAPI } from '@signalk/server-api'
import { fakeApp } from './helpers.js'

type Handler = (req: RegionsRequest, res: RegionsResponse) => void

function collector () {
  const routes = new Map<string, Handler>()
  const router: RegionsRouter = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
    delete: (p, h) => routes.set(`DELETE ${p}`, h)
  }
  return { router, routes }
}

function fakeRes () {
  const out: { code: number, body?: unknown, ended: boolean } = { code: 200, ended: false }
  const res: RegionsResponse = {
    status (c) { out.code = c; return res },
    json (v) { out.body = v },
    end () { out.ended = true }
  }
  return { res, out }
}

const securedApp = (): ServerAPI => fakeApp() as unknown as ServerAPI

test('routes are not mounted without a security strategy (fail closed)', () => {
  const { router, routes } = collector()
  const app = { error: () => {} } as unknown as ServerAPI
  assert.equal(registerRegionsRoutes(router, app, () => 'addr:8080'), false)
  assert.equal(routes.size, 0)
})

test('POST /api/position-warm/config floors the position-warm interval at 60 seconds', async () => {
  const { router, routes } = collector()
  const dir = mkdtempSync(join(tmpdir(), 'pw-'))
  registerRegionsRoutes(router, securedApp(), () => 'addr:8080', { dataDir: dir })
  const { res, out } = fakeRes()
  await routes.get('POST /api/position-warm/config')!({ params: {}, body: { positionWarm: { intervalSecs: 5 } } }, res)
  assert.equal(out.code, 204)
  const { loadRegionsStore } = await import('../src/runtime/regions-store.js')
  assert.equal(loadRegionsStore(dir).positionWarm.intervalSecs, 60)
})

test('routes report 503 when the container address is unset', async () => {
  const { router, routes } = collector()
  registerRegionsRoutes(router, securedApp(), () => null, { dataDir: mkdtempSync(join(tmpdir(), 'pw-')) })
  const { res, out } = fakeRes()
  await routes.get('GET /api/cache/stats')!({ params: {}, body: undefined }, res)
  assert.equal(out.code, 503)
})
