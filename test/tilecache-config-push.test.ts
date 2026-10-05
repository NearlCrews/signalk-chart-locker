import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSourcePayload, createRetentionPushQueue, pushTilecacheConfig, PLUGIN_PUBLIC_BASE } from '../src/runtime/tilecache-config-push.js'

test('buildSourcePayload carries the full registry, the public base, and the cap and budgets', async () => {
  const payload = await buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0)
  assert.equal(payload.publicBase, PLUGIN_PUBLIC_BASE)
  assert.ok(payload.sources.length >= 12, 'every registry source is included')
  const noaa = payload.sources.find((source) => source.id === 'depth-noaa-enc')
  const noaaQuality = payload.sources.find((source) => source.id === 'depth-noaa-enc-quality')
  assert.ok(noaa?.coverage !== undefined && noaa.coverage.length > 0)
  assert.deepEqual(noaaQuality?.coverage, noaa.coverage)
  assert.ok(payload.sources.some((s) => s.id === 'basemap'))
  assert.equal(payload.capBytes, 2_147_483_648)
  assert.equal(payload.regionsBudgetBytes, 1_073_741_824)
  assert.equal(payload.positionWarmBudgetBytes, 64 * 1024 * 1024)
  assert.equal(payload.geocodingEnabled, true)
})

// The container decides freshness, stale serving, and the warm skip from maxAgeSeconds alone, so the
// field has to survive both the payload build and its serialization. Trimming the pushed source to a
// smaller shape would silently turn every weather overlay back into a permanently cached one.
test('buildSourcePayload transmits the declared tile lifetime of a time-dynamic source', async () => {
  const payload = await buildSourcePayload(2_147_483_648, 1_073_741_824, 64 * 1024 * 1024, 0)
  const timeDynamic = payload.sources.filter((source) => source.maxAgeSeconds !== undefined)
  assert.ok(timeDynamic.length > 0, 'the catalog must still carry at least one time-dynamic source')
  for (const source of timeDynamic) {
    assert.ok(Number.isInteger(source.maxAgeSeconds) && source.maxAgeSeconds! > 0)
  }
  const serialized = JSON.parse(JSON.stringify(payload)) as { sources: Array<{ id: string, maxAgeSeconds?: number }> }
  assert.deepEqual(
    serialized.sources.filter((source) => source.maxAgeSeconds !== undefined).map((source) => source.id),
    timeDynamic.map((source) => source.id)
  )
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

test('the retention queue runs pushes in call order, each with the retention stored when it starts', async () => {
  let stored = 100
  const queue = createRetentionPushQueue(() => stored)
  let releaseFirst!: () => void
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
  let firstStarted!: () => void
  const firstRunning = new Promise<void>((resolve) => { firstStarted = resolve })
  const order: Array<{ push: string, ttlSecs: number }> = []
  const first = queue(async (ttlSecs) => { firstStarted(); await firstHeld; order.push({ push: 'first', ttlSecs }) })
  const second = queue(async (ttlSecs) => { order.push({ push: 'second', ttlSecs }) })
  await firstRunning
  // Saved while the first push is in flight: the second push has not read yet, so it carries this.
  stored = 200
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, [{ push: 'first', ttlSecs: 100 }, { push: 'second', ttlSecs: 200 }])
})

test('the retention queue falls back to the last value read, and fails a read with none', async () => {
  let readable = false
  const readErrors: unknown[] = []
  const queue = createRetentionPushQueue(() => {
    if (!readable) throw new Error('store unreadable')
    return 300
  }, (error) => readErrors.push(error))
  assert.throws(() => queue.current(), /store unreadable/)
  await assert.rejects(queue(async (ttlSecs) => ttlSecs), /store unreadable/)
  readable = true
  assert.equal(queue.current(), 300)
  readable = false
  assert.equal(await queue(async (ttlSecs) => ttlSecs), 300)
  assert.equal(readErrors.length, 1)
})

test('the retention queue falls back to a value just saved rather than an older read', async () => {
  let readable = true
  const queue = createRetentionPushQueue(() => {
    if (!readable) throw new Error('store unreadable')
    return 300
  })
  assert.equal(queue.current(), 300)
  queue.saved(600)
  readable = false
  assert.equal(await queue(async (ttlSecs) => ttlSecs), 600)
})
