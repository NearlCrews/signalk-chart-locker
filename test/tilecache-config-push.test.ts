import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSourcePayload, pushTilecacheConfig, PLUGIN_PUBLIC_BASE } from '../src/runtime/tilecache-config-push.js'
import type { FetchResponse } from '../src/shared/types.js'

test('buildSourcePayload carries the full registry, the public base, and the cap and budgets', () => {
  const payload = buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0)
  assert.equal(payload.publicBase, PLUGIN_PUBLIC_BASE)
  assert.ok(payload.sources.length >= 12, 'every registry source is included')
  assert.ok(payload.sources.some((s) => s.id === 'depth-noaa-enc'))
  assert.ok(payload.sources.some((s) => s.id === 'basemap'))
  assert.equal(payload.capBytes, 2_147_483_648)
  assert.equal(payload.regionsBudgetBytes, 1_073_741_824)
  assert.equal(payload.positionWarmBudgetBytes, 64 * 1024 * 1024)
})

test('buildSourcePayload carries scrollTtlSecs', () => {
  const payload = buildSourcePayload(100, 50, 5, 86_400)
  assert.equal(payload.scrollTtlSecs, 86_400)
})

test('pushTilecacheConfig posts the payload to /config and reports success', async () => {
  let posted: { url: string, body: string } | undefined
  const ok: FetchResponse = { ok: true, json: async () => ({}) } as unknown as FetchResponse
  const result = await pushTilecacheConfig('addr:8080', buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0), async (url, body) => {
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

test('pushTilecacheConfig returns false after every retry fails on a transport failure', async () => {
  let calls = 0
  const result = await pushTilecacheConfig(
    'addr:8080',
    buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0),
    async () => { calls++; throw new Error('down') },
    async () => {}
  )
  assert.equal(result, false)
  assert.equal(calls, 3, 'every retry attempt ran')
})

test('pushTilecacheConfig retries a transient failure and succeeds once the container is ready', async () => {
  // The exact race this retry exists for: a recreated container is not yet accepting connections when
  // the first attempt lands, and is ready by the time a later attempt runs.
  let calls = 0
  const ok: FetchResponse = { ok: true, json: async () => ({}) } as unknown as FetchResponse
  const result = await pushTilecacheConfig(
    'addr:8080',
    buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0),
    async () => {
      calls++
      if (calls < 3) throw new Error('connection refused')
      return ok
    },
    async () => {}
  )
  assert.equal(result, true)
  assert.equal(calls, 3, 'succeeded on the third attempt, after two transient failures')
})
