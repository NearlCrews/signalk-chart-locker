import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSourcePayload, pushTilecacheConfig, PLUGIN_PUBLIC_BASE } from '../src/runtime/tilecache-config-push.js'
import type { FetchResponse } from '../src/shared/types.js'

test('buildSourcePayload carries the full registry and the public base', () => {
  const payload = buildSourcePayload()
  assert.equal(payload.publicBase, PLUGIN_PUBLIC_BASE)
  assert.ok(payload.sources.length >= 12, 'every registry source is included')
  assert.ok(payload.sources.some((s) => s.id === 'depth-noaa-enc'))
  assert.ok(payload.sources.some((s) => s.id === 'basemap'))
})

test('pushTilecacheConfig posts the payload to /config and reports success', async () => {
  let posted: { url: string, body: string } | undefined
  const ok: FetchResponse = { ok: true, json: async () => ({}) } as unknown as FetchResponse
  const result = await pushTilecacheConfig('addr:8080', buildSourcePayload(), async (url, body) => {
    posted = { url, body }
    return ok
  })
  assert.equal(result, true)
  assert.equal(posted?.url, 'http://addr:8080/config')
  assert.ok(posted?.body.includes('"publicBase"'))
})

test('pushTilecacheConfig returns false on a transport failure', async () => {
  assert.equal(await pushTilecacheConfig('addr:8080', buildSourcePayload(), async () => { throw new Error('down') }), false)
})
