/** Bounded readers for JSON and diagnostic text returned by the managed tilecache container. */

/** Large enough for a MapLibre style document, while preventing an unbounded container response. */
export const MAX_MANAGED_CONTAINER_JSON_BYTES = 4 * 1024 * 1024
/** Error details are truncated to 500 characters by callers, so a small transport cap is sufficient. */
export const MAX_MANAGED_CONTAINER_ERROR_BYTES = 16 * 1024

export class ResponseBodyTooLargeError extends Error {
  constructor (maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`)
    this.name = 'ResponseBodyTooLargeError'
  }
}

function validateLimit (maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a nonnegative safe integer')
}

function declaredLength (response: Pick<Response, 'headers'>): number | undefined {
  const raw = response.headers.get('content-length')
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) throw new TypeError('response has an invalid Content-Length')
  const length = Number(raw)
  if (!Number.isSafeInteger(length)) throw new RangeError('response Content-Length is outside the safe integer range')
  return length
}

async function cancelResponseBody (response: Pick<Response, 'body'>): Promise<void> {
  if (response.body === null) return
  try { await response.body.cancel() } catch {}
}

/** Read at most `maxBytes`, bounding both declared and streamed, decompressed response bytes. */
export async function readBoundedResponseBytes (
  response: Pick<Response, 'headers' | 'body'>,
  maxBytes = MAX_MANAGED_CONTAINER_JSON_BYTES
): Promise<Uint8Array> {
  validateLimit(maxBytes)
  let declared: number | undefined
  try {
    declared = declaredLength(response)
  } catch (error) {
    await cancelResponseBody(response)
    throw error
  }
  if (declared !== undefined && declared > maxBytes) {
    await cancelResponseBody(response)
    throw new ResponseBodyTooLargeError(maxBytes)
  }
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new ResponseBodyTooLargeError(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function readBoundedResponseText (
  response: Pick<Response, 'headers' | 'body'>,
  maxBytes = MAX_MANAGED_CONTAINER_JSON_BYTES
): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, maxBytes))
}

export async function readBoundedResponseJson (
  response: Pick<Response, 'headers' | 'body'>,
  maxBytes = MAX_MANAGED_CONTAINER_JSON_BYTES
): Promise<unknown> {
  const body = await readBoundedResponseBytes(response, maxBytes)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
}
