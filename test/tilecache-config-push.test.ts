import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSourcePayload, pushTilecacheConfig, PLUGIN_PUBLIC_BASE } from '../src/runtime/tilecache-config-push.js'

test('buildSourcePayload carries the full registry, the public base, and the cap and budgets', async () => {
  const payload = await buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0)
  assert.equal(payload.publicBase, PLUGIN_PUBLIC_BASE)
  assert.ok(payload.sources.length >= 12, 'every registry source is included')
  assert.ok(payload.sources.some((s) => s.id === 'depth-noaa-enc'))
  assert.ok(payload.sources.some((s) => s.id === 'basemap'))
  assert.equal(payload.capBytes, 2_147_483_648)
  assert.equal(payload.regionsBudgetBytes, 1_073_741_824)
  assert.equal(payload.positionWarmBudgetBytes, 64 * 1024 * 1024)
  assert.equal(payload.geocodingEnabled, true)
})

test('buildSourcePayload carries scrollTtlSecs', async () => {
  const payload = await buildSourcePayload(100, 50, 5, 86_400)
  assert.equal(payload.scrollTtlSecs, 86_400)
})

test('pushTilecacheConfig authenticates the payload posted to /config and reports success', async () => {
  let posted: { url: string, body: string, headers: Record<string, string> } | undefined
  const ok = new Response(null, { status: 204 })
  const result = await pushTilecacheConfig('addr:8080', await buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0), {
    controlToken: 'secret-token',
    postJson: async (url, body, headers) => {
      posted = { url, body, headers }
      return ok
    }
  })
  assert.deepEqual(result, { ok: true, status: 204 })
  assert.equal(posted?.url, 'http://addr:8080/config')
  assert.equal(posted?.headers['x-tilecache-token'], 'secret-token')
  assert.ok(posted?.body.includes('"publicBase"'))
  assert.ok(posted?.body.includes('"capBytes"'))
  assert.ok(posted?.body.includes('"regionsBudgetBytes"'))
  assert.ok(posted?.body.includes('"positionWarmBudgetBytes"'))
})

test('pushTilecacheConfig returns false after every retry fails on a transport failure', async () => {
  let calls = 0
  const result = await pushTilecacheConfig(
    'addr:8080',
    await buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0),
    {
      controlToken: 'token',
      postJson: async () => { calls++; throw new Error('down') },
      delay: async () => {}
    }
  )
  assert.equal(result.ok, false)
  assert.equal(calls, 3, 'every retry attempt ran')
})

test('pushTilecacheConfig retries a transient failure and succeeds once the container is ready', async () => {
  // The exact race this retry exists for: a recreated container is not yet accepting connections when
  // the first attempt lands, and is ready by the time a later attempt runs.
  let calls = 0
  const ok = new Response(null, { status: 204 })
  const result = await pushTilecacheConfig(
    'addr:8080',
    await buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0),
    {
      controlToken: 'token',
      postJson: async () => {
        calls++
        if (calls < 3) throw new Error('connection refused')
        return ok
      },
      delay: async () => {}
    }
  )
  assert.equal(result.ok, true)
  assert.equal(calls, 3, 'succeeded on the third attempt, after two transient failures')
})

test('pushTilecacheConfig does not retry a deterministic 400 and preserves response detail', async () => {
  let calls = 0
  const result = await pushTilecacheConfig('addr:8080', await buildSourcePayload(1, 1, 0, 0), {
    controlToken: 'token',
    postJson: async () => {
      calls++
      return new Response('bad source', { status: 400 })
    },
    delay: async () => {}
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { ok: false, status: 400, error: 'tilecache rejected config with HTTP 400: bad source' })
})

test('pushTilecacheConfig bounds a deterministic rejection body', async () => {
  const result = await pushTilecacheConfig('addr:8080', await buildSourcePayload(1, 1, 0, 0), {
    controlToken: 'token',
    postJson: async () => new Response('ignored', {
      status: 400,
      headers: { 'content-length': String(1024 * 1024) }
    }),
    delay: async () => {}
  })
  assert.deepEqual(result, { ok: false, status: 400, error: 'tilecache rejected config with HTTP 400' })
})

test('pushTilecacheConfig cooperatively aborts an in-flight startup request without retrying', async () => {
  const controller = new AbortController()
  let calls = 0
  let started: (() => void) | undefined
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  const pushed = pushTilecacheConfig('addr:8080', await buildSourcePayload(1, 1, 0, 0), {
    controlToken: 'token',
    signal: controller.signal,
    postJson: async (_url, _body, _headers, signal) => {
      calls++
      started?.()
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
  })
  await requestStarted
  controller.abort()
  assert.deepEqual(await pushed, { ok: false, error: 'tilecache configuration cancelled' })
  assert.equal(calls, 1)
})
