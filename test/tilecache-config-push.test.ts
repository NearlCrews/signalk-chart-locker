import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSourcePayload, pushTilecacheConfig, PLUGIN_PUBLIC_BASE } from '../src/runtime/tilecache-config-push.js'
import type { FetchResponse } from '../src/shared/types.js'

test('buildSourcePayload carries the full registry, the public base, and the cap and budgets', () => {
  const payload = buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024)
  assert.equal(payload.publicBase, PLUGIN_PUBLIC_BASE)
  assert.ok(payload.sources.length >= 12, 'every registry source is included')
  assert.ok(payload.sources.some((s) => s.id === 'depth-noaa-enc'))
  assert.ok(payload.sources.some((s) => s.id === 'basemap'))
  assert.equal(payload.capBytes, 2_147_483_648)
  assert.equal(payload.regionsBudgetBytes, 1_073_741_824)
  assert.equal(payload.positionWarmBudgetBytes, 64 * 1024 * 1024)
})

test('pushTilecacheConfig posts the payload to /config and reports success', async () => {
  let posted: { url: string, body: string } | undefined
  const ok: FetchResponse = { ok: true, json: async () => ({}) } as unknown as FetchResponse
  const result = await pushTilecacheConfig('addr:8080', buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024), async (url, body) => {
    posted = { url, body }
    return ok
  })
  assert.equal(result, true)
  assert.equal(posted?.url, 'http://addr:8080/config')
  assert.ok(posted?.body.includes('"publicBase"'))
  assert.ok(posted?.body.includes('"capBytes"'))
  assert.ok(posted?.body.includes('"regionsBudgetBytes"'))
  assert.ok(posted?.body.includes('"positionWarmBudgetBytes"'))
})

test('pushTilecacheConfig returns false on a transport failure', async () => {
  assert.equal(await pushTilecacheConfig('addr:8080', buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024), async () => { throw new Error('down') }), false)
})
