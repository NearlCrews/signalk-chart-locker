// test/chart-registry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ChartRegistry,
  chartResource,
  registerChartProvider,
  serveUrl,
  type ChartRecord
} from '../src/charts/chart-registry.js'
import type { ResourceProvider } from '@signalk/server-api'

function record (fileName: string): ChartRecord {
  return {
    identifier: fileName.replace('.pmtiles', '-pmtiles'),
    fileName,
    filePath: `/charts/${fileName}`,
    name: fileName.replace('.pmtiles', ''),
    description: '',
    type: 'tilelayer',
    scale: 250000,
    decoded: { minzoom: 0, maxzoom: 14, bounds: [-122, 37, -121, 38], format: 'mvt', vectorLayers: ['water'] }
  }
}

test('chartResource points url and tilemapUrl at the serve route and carries the decoded metadata', () => {
  const r = chartResource(record('sf.pmtiles'))
  assert.equal(r.identifier, 'sf-pmtiles')
  assert.equal(r.url, serveUrl('sf.pmtiles'))
  assert.equal(r.tilemapUrl, serveUrl('sf.pmtiles'))
  assert.deepEqual(r.bounds, [-122, 37, -121, 38])
  assert.equal(r.format, 'mvt')
  assert.deepEqual(r.layers, ['water'])
})

test('the registry resolves a file path by id and lists resources', () => {
  const registry = new ChartRegistry()
  registry.set(record('sf.pmtiles'))
  assert.equal(registry.filePathFor('sf-pmtiles'), '/charts/sf.pmtiles')
  assert.equal(registry.filePathFor('missing-pmtiles'), undefined)
  assert.equal(registry.list().length, 1)
  registry.clear()
  assert.equal(registry.list().length, 0)
})

test('registerChartProvider exposes the live registry through the v2 provider and the v1 route', async () => {
  const registry = new ChartRegistry()
  let provider: ResourceProvider | undefined
  const routes: Record<string, (req: { params: Record<string, string> }, res: FakeRes) => void> = {}
  const app = {
    get (path: string, handler: (req: { params: Record<string, string> }, res: FakeRes) => void) { routes[path] = handler },
    registerResourceProvider (p: ResourceProvider) { provider = p }
  }
  registerChartProvider(app as never, registry)
  registry.set(record('sf.pmtiles'))

  const list = await provider!.methods.listResources({})
  assert.equal(Object.keys(list).length, 1)
  const got = await provider!.methods.getResource('sf-pmtiles')
  assert.equal((got as { identifier: string }).identifier, 'sf-pmtiles')
  await assert.rejects(() => provider!.methods.getResource('nope'))

  const res = new FakeRes()
  routes['/signalk/v1/api/resources/charts']({ params: {} }, res)
  assert.equal(Object.keys(res.body as object).length, 1)
})

test('the v1 single-chart route returns an existing chart resource by identifier', () => {
  const registry = new ChartRegistry()
  const routes: Record<string, (req: { params: Record<string, string> }, res: FakeRes) => void> = {}
  const app = {
    get (path: string, handler: (req: { params: Record<string, string> }, res: FakeRes) => void) { routes[path] = handler },
    registerResourceProvider () {}
  }
  registerChartProvider(app as never, registry)
  registry.set(record('sf.pmtiles'))

  const res = new FakeRes()
  routes['/signalk/v1/api/resources/charts/:identifier']({ params: { identifier: 'sf-pmtiles' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal((res.body as { identifier: string }).identifier, 'sf-pmtiles')
})

test('the v1 single-chart route returns 404 for unknown chart identifier', () => {
  const registry = new ChartRegistry()
  const routes: Record<string, (req: { params: Record<string, string> }, res: FakeRes) => void> = {}
  const app = {
    get (path: string, handler: (req: { params: Record<string, string> }, res: FakeRes) => void) { routes[path] = handler },
    registerResourceProvider () {}
  }
  registerChartProvider(app as never, registry)

  const res = new FakeRes()
  routes['/signalk/v1/api/resources/charts/:identifier']({ params: { identifier: 'nope' } }, res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body, 'Not found')
})

test('registerChartProvider registers the provider only once per app', () => {
  const registry = new ChartRegistry()
  let count = 0
  const app = { get () {}, registerResourceProvider () { count++ } }
  registerChartProvider(app as never, registry)
  registerChartProvider(app as never, registry)
  assert.equal(count, 1)
})

test('a failed provider registration remains retryable', () => {
  const registry = new ChartRegistry()
  let attempts = 0
  const app = {
    get () {},
    registerResourceProvider () {
      attempts++
      if (attempts === 1) throw new Error('temporary registration failure')
    }
  }
  assert.throws(() => { registerChartProvider(app as never, registry) }, /temporary registration/)
  assert.doesNotThrow(() => { registerChartProvider(app as never, registry) })
  assert.equal(attempts, 2)
})

test('a repeated registration rebinds permanent provider methods to the new registry', async () => {
  let provider: ResourceProvider | undefined
  const app = {
    get () {},
    registerResourceProvider (value: ResourceProvider) { provider = value }
  }
  const first = new ChartRegistry()
  first.set(record('first.pmtiles'))
  registerChartProvider(app as never, first)
  assert.deepEqual(Object.keys(await provider!.methods.listResources({})), ['first-pmtiles'])

  const second = new ChartRegistry()
  second.set(record('second.pmtiles'))
  registerChartProvider(app as never, second)
  assert.deepEqual(Object.keys(await provider!.methods.listResources({})), ['second-pmtiles'])
})

class FakeRes {
  body: unknown
  statusCode = 200
  json (b: unknown): void { this.body = b }
  status (c: number): this { this.statusCode = c; return this }
  send (b: string): void { this.body = b }
}
