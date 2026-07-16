import test from 'node:test'
import assert from 'node:assert/strict'
import { readFreeGiB } from '../src/runtime/free-space.js'

test('readFreeGiB returns a finite whole GiB count', () => {
  assert.equal(readFreeGiB('/data', () => ({ bsize: 4096, bavail: 3 * 1024 ** 2 })), 12)
})

test('readFreeGiB rejects malformed statfs values', () => {
  for (const result of [
    { bsize: 0, bavail: 1 },
    { bsize: 4096, bavail: -1 },
    { bsize: Number.NaN, bavail: 1 },
    { bsize: 4096, bavail: Number.POSITIVE_INFINITY },
    { bsize: 1.5, bavail: 1 },
    { bsize: Number.MAX_SAFE_INTEGER, bavail: 2 }
  ]) {
    assert.throws(() => readFreeGiB('/data', () => result), RangeError)
  }
})
