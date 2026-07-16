import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export async function readResponseWithLimit (response, maximumBytes) {
  assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'download limit must be a positive integer')
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    assert.ok(Number.isSafeInteger(parsedLength) && parsedLength >= 0, 'download Content-Length is invalid')
    assert.ok(parsedLength <= maximumBytes, `download exceeds the ${maximumBytes}-byte limit`)
  }
  assert.ok(response.body, 'download response has no body')

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new Error(`download exceeds the ${maximumBytes}-byte limit`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

export function writeFileAtomically (path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
