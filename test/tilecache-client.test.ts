import test from 'node:test'
import assert from 'node:assert/strict'
import { getRegionByteTotals, warmRegion } from '../src/runtime/tilecache-client.js'

test('warmRegion posts the warm and polls to the terminal result', async () => {
  const calls: string[] = []
  const fetchImpl = async (url: string) => {
    calls.push(url)
    if (url.endsWith('/warm')) return { ok: true, status: 200, json: async () => ({ jobId: 'warm-7' }) } as unknown as Response
    return { ok: true, status: 200, json: async () => ({ state: 'done', errors: 0, total: 4 }) } as unknown as Response
  }
  const result = await warmRegion('addr:8080', { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 }, fetchImpl as unknown as typeof fetch)
  assert.deepEqual(result, { errors: 0, total: 4 })
  assert.equal(calls[0], 'http://addr:8080/warm')
  assert.ok(calls[1].startsWith('http://addr:8080/warm/warm-7'))
})

test('warmRegion returns null when the job is gone (404)', async () => {
  const fetchImpl = async (url: string) =>
    url.endsWith('/warm')
      ? ({ ok: true, status: 200, json: async () => ({ jobId: 'warm-8' }) } as unknown as Response)
      : ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)
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
    ? ({ ok: true, status: 200, json: async () => ({ jobId: 'warm-9' }) } as unknown as Response)
    : ({ ok: true, status: 200, json: async () => ({ state: 'finished-ish', errors: 0, total: 1 }) } as unknown as Response)
  const result = await warmRegion('addr:8080', { bbox: [-1, -1, 1, 1], sources: ['seamark'], minzoom: 6, maxzoom: 7 }, fetchImpl as unknown as typeof fetch)
  assert.equal(result, null)
})

test('getRegionByteTotals rejects a partially malformed totals map', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ regions: { good: 10, bad: -1 } }), { status: 200 })
  assert.equal(await getRegionByteTotals('addr:8080', fetchImpl as unknown as typeof fetch), null)
})
