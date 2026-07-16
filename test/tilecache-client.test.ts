import test from 'node:test'
import assert from 'node:assert/strict'
import { getRegionByteTotals, warmRegion } from '../src/runtime/tilecache-client.js'

const WARM_BOOT_ID = '0123456789abcdef0123456789abcdef'
const warmJobId = (counter: number): string => `warm-${WARM_BOOT_ID}-${counter}`

test('warmRegion posts the warm and polls to the terminal result', async () => {
  const calls: string[] = []
  let startHeaders: HeadersInit | undefined
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(url)
    if (url.endsWith('/warm')) {
      startHeaders = init?.headers
      return Response.json({ jobId: warmJobId(7) })
    }
    return Response.json({ state: 'done', errors: 0, total: 4, done: 4, skipped: 0, bytes: 100 })
  }
  const result = await warmRegion('addr:8080', { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 }, fetchImpl as unknown as typeof fetch, 'control-secret')
  assert.deepEqual(result, { state: 'done', errors: 0, total: 4 })
  assert.equal(calls[0], 'http://addr:8080/warm')
  assert.ok(calls[1].startsWith(`http://addr:8080/warm/${warmJobId(7)}`))
  assert.equal((startHeaders as Record<string, string>)['x-tilecache-token'], 'control-secret')
})

test('warmRegion returns null when the job is gone (404)', async () => {
  const fetchImpl = async (url: string) =>
    url.endsWith('/warm')
      ? Response.json({ jobId: warmJobId(8) })
      : Response.json({}, { status: 404 })
  const result = await warmRegion('addr:8080', { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 }, fetchImpl as unknown as typeof fetch)
  assert.equal(result, null)
})

test('warmRegion never retries a failed warm-start POST', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    throw new Error('response lost')
  }
  const result = await warmRegion('addr:8080', { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 }, fetchImpl as unknown as typeof fetch)
  assert.equal(result, null)
  assert.equal(calls, 1)
})

test('warmRegion rejects an unknown terminal state', async () => {
  const fetchImpl = async (url: string) => url.endsWith('/warm')
    ? Response.json({ jobId: warmJobId(9) })
    : Response.json({ state: 'finished-ish', errors: 0, total: 1, done: 1, skipped: 0, bytes: 1 })
  const result = await warmRegion('addr:8080', { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 }, fetchImpl as unknown as typeof fetch)
  assert.equal(result, null)
})

test('warmRegion rejects malformed container job identifiers before polling', async () => {
  for (const jobId of ['bad/job', 'bad\njob', 'x'.repeat(65)]) {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return Response.json({ jobId })
    }
    const result = await warmRegion('addr:8080', { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 }, fetchImpl as unknown as typeof fetch)
    assert.equal(result, null, jobId)
    assert.equal(calls, 1, jobId)
  }
})

test('getRegionByteTotals rejects a partially malformed totals map', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ regions: { good: 10, bad: -1 } }), { status: 200 })
  assert.equal(await getRegionByteTotals('addr:8080', fetchImpl as unknown as typeof fetch), null)
})

test('managed-container clients reject oversized JSON responses', async () => {
  const oversized = (): Response => new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } })
  assert.equal(await getRegionByteTotals('addr:8080', async () => oversized()), null)
  assert.equal(await warmRegion(
    'addr:8080',
    { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 },
    async () => oversized()
  ), null)
})

test('getRegionByteTotals returns a null-prototype map and rejects unbounded totals', async () => {
  const validFetch = async () => new Response(JSON.stringify({ regions: { region: 10 } }), { status: 200 })
  const valid = await getRegionByteTotals('addr:8080', validFetch as unknown as typeof fetch)
  assert.deepEqual({ ...valid }, { region: 10 })
  assert.equal(Object.getPrototypeOf(valid), null)

  const tooMany = Object.fromEntries(Array.from({ length: 137 }, (_, index) => [`r-${index}`, index]))
  const overflowFetch = async () => new Response(JSON.stringify({ regions: tooMany }), { status: 200 })
  assert.equal(await getRegionByteTotals('addr:8080', overflowFetch as unknown as typeof fetch), null)

  const longIdFetch = async () => new Response(JSON.stringify({ regions: { ['x'.repeat(129)]: 1 } }), { status: 200 })
  assert.equal(await getRegionByteTotals('addr:8080', longIdFetch as unknown as typeof fetch), null)

  const controlledTotals: Record<string, number> = {}
  controlledTotals['bad\u2028id'] = 1
  const controlledIdFetch = async () => new Response(JSON.stringify({ regions: controlledTotals }), { status: 200 })
  assert.equal(await getRegionByteTotals('addr:8080', controlledIdFetch as unknown as typeof fetch), null)
})

test('getRegionByteTotals cooperatively aborts an in-flight startup request', async () => {
  const controller = new AbortController()
  let started: (() => void) | undefined
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  let aborted = false
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    started?.()
    return await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }
  const result = getRegionByteTotals('addr:8080', fetchImpl, controller.signal)
  await requestStarted
  controller.abort()
  assert.equal(await result, null)
  assert.equal(aborted, true)
})

test('warmRegion cooperatively aborts an in-flight status request', async () => {
  const controller = new AbortController()
  let statusStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => { statusStarted = resolve })
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/warm')) return Response.json({ jobId: warmJobId(10) })
    statusStarted?.()
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }
  const result = warmRegion(
    'addr:8080',
    { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 },
    fetchImpl as unknown as typeof fetch,
    undefined,
    controller.signal
  )
  await started
  controller.abort()
  assert.equal(await result, null)
})
