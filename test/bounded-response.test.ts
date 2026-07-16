import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readBoundedResponseJson,
  readBoundedResponseText,
  ResponseBodyTooLargeError
} from '../src/runtime/bounded-response.js'

test('bounded response readers parse bodies within the limit', async () => {
  const response = Response.json({ status: 'ok' })
  assert.deepEqual(await readBoundedResponseJson(response, 1024), { status: 'ok' })
})

test('bounded response readers reject an oversized declared body', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start (controller) {
      controller.enqueue(new TextEncoder().encode('small'))
    },
    cancel () {
      cancelled = true
    }
  }), { headers: { 'content-length': '1025' } })
  await assert.rejects(readBoundedResponseText(response, 1024), ResponseBodyTooLargeError)
  assert.equal(cancelled, true)
})

test('bounded response readers cancel a body with an invalid declared length', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start (controller) {
      controller.enqueue(new Uint8Array([1]))
    },
    cancel () {
      cancelled = true
    }
  }), { headers: { 'content-length': 'unsafe' } })
  await assert.rejects(readBoundedResponseText(response, 1024), TypeError)
  assert.equal(cancelled, true)
})

test('bounded response readers cancel a streamed body that exceeds the limit', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    start (controller) {
      controller.enqueue(new Uint8Array(768))
      controller.enqueue(new Uint8Array(768))
    },
    cancel () {
      cancelled = true
    }
  }))
  await assert.rejects(readBoundedResponseText(response, 1024), ResponseBodyTooLargeError)
  assert.equal(cancelled, true)
})

test('bounded JSON decoding rejects malformed UTF-8', async () => {
  const response = new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
  await assert.rejects(readBoundedResponseJson(response, 1024), TypeError)
})
