import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTilecacheConfig,
  probeTilecacheHealth,
  TILECACHE_INTERNAL_PORT,
  DEFAULT_TILECACHE_IMAGE,
  DEFAULT_CACHE_CAP_GIB
} from '../src/runtime/tilecache-container.js'
import type { FetchResponse } from '../src/shared/types.js'

test('buildTilecacheConfig exposes the port, the healthcheck, the data mount, and the cache env', () => {
  const c = buildTilecacheConfig()
  assert.equal(c.image, DEFAULT_TILECACHE_IMAGE)
  assert.deepEqual(c.signalkAccessiblePorts, [TILECACHE_INTERNAL_PORT])
  assert.deepEqual(c.healthcheck?.test, ['CMD', '/tilecache', 'healthcheck'])
  assert.equal(c.signalkDataMount, '/signalk-data')
  assert.equal(c.env?.TILECACHE_DB, '/signalk-data/chart-locker-tilecache/cache.sqlite')
  assert.equal(c.env?.TILECACHE_CAP_BYTES, String(DEFAULT_CACHE_CAP_GIB * 1024 ** 3))
  assert.equal(c.volumes, undefined) // no external volume by default
})

test('buildTilecacheConfig honors a custom cap and image tag', () => {
  const c = buildTilecacheConfig({ tag: 'v1', capBytes: 1000 })
  assert.equal(c.tag, 'v1')
  assert.equal(c.env?.TILECACHE_CAP_BYTES, '1000')
})

test('buildTilecacheConfig defaults the image tag to the plugin version, not latest', () => {
  // A version tag (vX.Y.Z) changes every release, which is what forces signalk-container to recreate
  // the container; a floating "latest" never would.
  assert.match(buildTilecacheConfig().tag ?? '', /^v\d+\.\d+\.\d+/)
  // An explicit override still wins, so a developer can point at latest or a hand-built tag.
  assert.equal(buildTilecacheConfig({ tag: 'latest' }).tag, 'latest')
})

test('buildTilecacheConfig sets the scroll TTL env in seconds', () => {
  const c = buildTilecacheConfig({ capBytes: 1024, scrollTtlSecs: 2_592_000 })
  assert.equal(c.env?.TILECACHE_SCROLL_TTL_SECS, '2592000')
})

test('buildTilecacheConfig defaults the scroll TTL env to 0 when unset', () => {
  const c = buildTilecacheConfig()
  assert.equal(c.env?.TILECACHE_SCROLL_TTL_SECS, '0')
})

test('an external cache volume source mounts at the cache dir with a skip-if-missing policy', () => {
  const c = buildTilecacheConfig({ externalCacheVolumeSource: '/media/ssd/binnacle' })
  assert.deepEqual(c.volumes, {
    '/signalk-data/chart-locker-tilecache': { source: '/media/ssd/binnacle', ifMissing: 'skip' }
  })
})

test('probeTilecacheHealth is true only on a 200 with status ok', async () => {
  const ok: FetchResponse = { ok: true, json: async () => ({ status: 'ok' }) } as unknown as FetchResponse
  assert.equal(await probeTilecacheHealth('addr:8080', async () => ok), true)
  const notOk: FetchResponse = { ok: false, json: async () => ({}) } as unknown as FetchResponse
  assert.equal(await probeTilecacheHealth('addr:8080', async () => notOk), false)
  assert.equal(await probeTilecacheHealth('addr:8080', async () => { throw new Error('down') }), false)
})
