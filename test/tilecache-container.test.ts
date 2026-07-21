import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTilecacheConfig,
  probeTilecacheHealth,
  probeTilecacheHealthStatus,
  TILECACHE_INTERNAL_PORT,
  DEFAULT_TILECACHE_IMAGE,
  DEFAULT_CACHE_CAP_GIB,
  DEFAULT_TILECACHE_TAG
} from '../src/runtime/tilecache-container.js'

test('buildTilecacheConfig exposes the port, the healthcheck, the data mount, and the cache env', () => {
  const c = buildTilecacheConfig()
  assert.equal(c.image, DEFAULT_TILECACHE_IMAGE)
  assert.deepEqual(c.signalkAccessiblePorts, [TILECACHE_INTERNAL_PORT])
  assert.deepEqual(c.healthcheck?.test, ['CMD', '/tilecache', 'healthcheck'])
  assert.equal(c.signalkDataMount, '/signalk-data')
  assert.deepEqual(c.user, { inImageUid: 65532, inImageGid: 65532 })
  assert.equal(c.env?.TILECACHE_DB, '/signalk-data/chart-locker-tilecache/cache.sqlite')
  assert.equal(c.env?.TILECACHE_CAP_BYTES, String(DEFAULT_CACHE_CAP_GIB * 1024 ** 3))
  assert.equal(c.env?.TILECACHE_GEOCODING_ENABLED, '1')
  assert.equal(c.volumes, undefined) // no external volume by default
})

test('buildTilecacheConfig carries the stable control token and geocoding policy', () => {
  const c = buildTilecacheConfig({ controlToken: 'private-token', geocodingEnabled: false })
  assert.equal(c.env?.TILECACHE_CONTROL_TOKEN, 'private-token')
  assert.equal(c.env?.TILECACHE_GEOCODING_ENABLED, '0')
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
  // Earlier schemas persisted their release tag as the default. Treat every published predecessor
  // as inherited so a skipped-version upgrade cannot pin an incompatible older container protocol.
  for (const tag of ['v0.1.0', 'v0.1.1', 'v0.2.0', 'v0.3.0', 'v0.3.1', 'v0.4.0', 'v0.4.1', 'v0.4.2', 'v0.4.3', 'v0.4.4', 'v0.5.0']) {
    assert.equal(buildTilecacheConfig({ tag }).tag, DEFAULT_TILECACHE_TAG, tag)
  }
})

test('buildTilecacheConfig sets the scroll TTL env in seconds', () => {
  const c = buildTilecacheConfig({ capBytes: 1024, scrollTtlSecs: 2_592_000 })
  assert.equal(c.env?.TILECACHE_SCROLL_TTL_SECS, '2592000')
})

test('buildTilecacheConfig defaults the scroll TTL env to 0 when unset', () => {
  const c = buildTilecacheConfig()
  assert.equal(c.env?.TILECACHE_SCROLL_TTL_SECS, '0')
})

test('an external cache volume source mounts at the cache dir and aborts when the path is absent', () => {
  const c = buildTilecacheConfig({ externalCacheVolumeSource: '/media/ssd/binnacle' })
  assert.deepEqual(c.volumes, {
    '/signalk-data/chart-locker-tilecache': { source: '/media/ssd/binnacle', ifMissing: 'abort' }
  })
})

test('probeTilecacheHealth is true only on a 200 with status ok', async () => {
  assert.equal(await probeTilecacheHealth('addr:8080', async () => Response.json({ status: 'ok' })), true)
  assert.equal(await probeTilecacheHealth('addr:8080', async () => Response.json({}, { status: 503 })), false)
  assert.equal(await probeTilecacheHealth('addr:8080', async () => { throw new Error('down') }), false)
})

test('probeTilecacheHealthStatus preserves the configured readiness flag', async () => {
  assert.deepEqual(
    await probeTilecacheHealthStatus('addr:8080', async () => Response.json({ status: 'ok', configured: false })),
    { healthy: true, configured: false }
  )
})

test('probeTilecacheHealth rejects an oversized JSON response', async () => {
  const oversized = new Response('{"status":"ok"}', { headers: { 'content-length': String(5 * 1024 * 1024) } })
  assert.equal(await probeTilecacheHealth('addr:8080', async () => oversized), false)
})
