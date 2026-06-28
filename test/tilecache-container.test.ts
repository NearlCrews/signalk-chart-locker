import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTilecacheConfig,
  probeTilecacheHealth,
  TILECACHE_INTERNAL_PORT,
  DEFAULT_TILECACHE_IMAGE,
  DEFAULT_CACHE_CAP_BYTES
} from '../src/runtime/tilecache-container.js'
import type { FetchResponse } from '../src/shared/types.js'

test('buildTilecacheConfig exposes the port, the healthcheck, the data mount, and the cache env', () => {
  const c = buildTilecacheConfig()
  assert.equal(c.image, DEFAULT_TILECACHE_IMAGE)
  assert.deepEqual(c.signalkAccessiblePorts, [TILECACHE_INTERNAL_PORT])
  assert.deepEqual(c.healthcheck?.test, ['CMD', '/tilecache', 'healthcheck'])
  assert.equal(c.signalkDataMount, '/signalk-data')
  assert.equal(c.env?.TILECACHE_DB, '/signalk-data/binnacle-tilecache/cache.sqlite')
  assert.equal(c.env?.TILECACHE_CAP_BYTES, String(DEFAULT_CACHE_CAP_BYTES))
  assert.equal(c.volumes, undefined) // no external volume by default
})

test('buildTilecacheConfig honors a custom cap and image tag', () => {
  const c = buildTilecacheConfig({ tag: 'v1', capBytes: 1000 })
  assert.equal(c.tag, 'v1')
  assert.equal(c.env?.TILECACHE_CAP_BYTES, '1000')
})

test('an external cache volume source mounts at the cache dir with a skip-if-missing policy', () => {
  const c = buildTilecacheConfig({ externalCacheVolumeSource: '/media/ssd/binnacle' })
  assert.deepEqual(c.volumes, {
    '/signalk-data/binnacle-tilecache': { source: '/media/ssd/binnacle', ifMissing: 'skip' }
  })
})

test('probeTilecacheHealth is true only on a 200 with status ok', async () => {
  const ok: FetchResponse = { ok: true, json: async () => ({ status: 'ok' }) } as unknown as FetchResponse
  assert.equal(await probeTilecacheHealth('addr:8080', async () => ok), true)
  const notOk: FetchResponse = { ok: false, json: async () => ({}) } as unknown as FetchResponse
  assert.equal(await probeTilecacheHealth('addr:8080', async () => notOk), false)
  assert.equal(await probeTilecacheHealth('addr:8080', async () => { throw new Error('down') }), false)
})
