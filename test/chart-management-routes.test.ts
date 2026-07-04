// test/chart-management-routes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerAPI } from '@signalk/server-api'
import { ChartRegistry, type ChartRecord } from '../src/charts/chart-registry.js'
import { OverrideStore } from '../src/charts/overrides.js'
import {
  registerChartManagementRoutes,
  type ManagementRequest,
  type ManagementResponse
} from '../src/http/chart-management-routes.js'
import { fakeApp } from './helpers.js'

const securedApp = (): ServerAPI => fakeApp() as unknown as ServerAPI

function record (): ChartRecord {
  return {
    identifier: 'sf-pmtiles',
    fileName: 'sf.pmtiles',
    filePath: '/charts/sf.pmtiles',
    name: 'sf',
    description: '',
    type: 'tilelayer',
    scale: 250000,
    decoded: {
      minzoom: 0,
      maxzoom: 14,
      bounds: [-122, 37, -121, 38] as [number, number, number, number],
      format: 'mvt' as const,
      vectorLayers: ['water']
    }
  }
}

class FakeRes implements ManagementResponse {
  body: unknown
  statusCode = 200
  json (b: unknown): void { this.body = b }
  status (c: number): this { this.statusCode = c; return this }
}

function collect (): { get: Record<string, (req: ManagementRequest, res: FakeRes) => void>, post: Record<string, (req: ManagementRequest, res: FakeRes) => void>, registry: ChartRegistry, overrides: OverrideStore, applied: number } {
  const get: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
  const post: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  const overrides = new OverrideStore('/dev/null')
  const state = { applied: 0 }
  registerChartManagementRoutes(
    {
      get (p, h) { get[p] = h as (req: ManagementRequest, res: FakeRes) => void },
      post (p, h) { post[p] = h as (req: ManagementRequest, res: FakeRes) => void }
    },
    securedApp(),
    registry,
    overrides,
    () => { state.applied++ }
  )
  return { get, post, registry, overrides, applied: state.applied }
}

test('GET /api/charts lists valid charts and decode errors with overrides', () => {
  const ctx = collect()
  ctx.registry.set(record())
  ctx.registry.setError('broken.pmtiles', 'unknown tile type 0')
  const res = new FakeRes()
  ctx.get['/api/charts']({ params: {}, body: undefined }, res)
  const body = res.body as { charts: Record<string, unknown>[], invalid: unknown[] }
  assert.equal(body.charts.length, 1)
  assert.equal(body.invalid.length, 1)
  assert.ok('override' in body.charts[0], 'each chart record must include the override field')
  assert.equal(typeof body.charts[0].override, 'object')
})

test('POST /api/charts/:id/override persists the override and triggers a re-apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mgmt-'))
  try {
    const overrides = new OverrideStore(join(dir, 'overrides.json'))
    overrides.load()
    const get: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
    const post: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
    const registry = new ChartRegistry()
    registry.set(record())
    let applied = 0
    registerChartManagementRoutes(
      { get (p, h) { get[p] = h as never }, post (p, h) { post[p] = h as never } },
      securedApp(), registry, overrides, () => { applied++ }
    )
    const res = new FakeRes()
    post['/api/charts/:id/override']({ params: { id: 'sf-pmtiles' }, body: { name: 'Renamed' } }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(overrides.get('sf-pmtiles'), { name: 'Renamed' })
    assert.equal(applied, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /api/charts/:id/override merges fields instead of replacing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mgmt-'))
  try {
    const overrides = new OverrideStore(join(dir, 'overrides.json'))
    overrides.load()
    const get: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
    const post: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
    const registry = new ChartRegistry()
    registry.set(record())
    registerChartManagementRoutes(
      { get (p, h) { get[p] = h as never }, post (p, h) { post[p] = h as never } },
      securedApp(), registry, overrides, () => {}
    )
    post['/api/charts/:id/override']({ params: { id: 'sf-pmtiles' }, body: { name: 'Renamed', description: 'Bay' } }, new FakeRes())
    // A second post setting only the scale must not wipe the name and description.
    const res = new FakeRes()
    post['/api/charts/:id/override']({ params: { id: 'sf-pmtiles' }, body: { scale: 50000 } }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(overrides.get('sf-pmtiles'), { name: 'Renamed', description: 'Bay', scale: 50000 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST with a non-object body returns 400', () => {
  const ctx = collect()
  ctx.registry.set(record())
  const res = new FakeRes()
  ctx.post['/api/charts/:id/override']({ params: { id: 'sf-pmtiles' }, body: 'nope' }, res)
  assert.equal(res.statusCode, 400)
})

test('routes are not mounted without a security strategy (fail closed)', () => {
  const get: Record<string, unknown> = {}
  const post: Record<string, unknown> = {}
  const app = { error: () => {} } as unknown as ServerAPI
  const mounted = registerChartManagementRoutes(
    { get (p, h) { get[p] = h as never }, post (p, h) { post[p] = h as never } },
    app,
    new ChartRegistry(),
    new OverrideStore('/dev/null'),
    () => {}
  )
  assert.equal(mounted, false)
  assert.equal(Object.keys(get).length, 0)
  assert.equal(Object.keys(post).length, 0)
})
