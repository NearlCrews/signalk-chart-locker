import test from 'node:test'
import assert from 'node:assert/strict'
import { isWarmJobSnapshot, isWarmSnapshot, validWarmJobId } from '../src/runtime/warm-contract.js'

const done = { state: 'done', total: 2, done: 2, skipped: 0, bytes: 10, errors: 0 }
const bootId = '0123456789abcdef0123456789abcdef'

test('warm contract accepts complete snapshots and the generated Rust job-ID shape', () => {
  assert.equal(isWarmSnapshot(done), true)
  assert.equal(isWarmJobSnapshot({ ...done, jobId: `warm-${bootId}-18446744073709551615` }), true)
})

test('warm contract rejects incomplete terminal snapshots and malformed job IDs', () => {
  assert.equal(isWarmSnapshot({ ...done, done: 1 }), false)
  assert.equal(isWarmSnapshot({
    ...done,
    total: Number.MAX_SAFE_INTEGER,
    done: Number.MAX_SAFE_INTEGER,
    skipped: 1
  }), false)
  for (const id of [
    '',
    'bad/job',
    `warm-${bootId.toUpperCase()}-1`,
    `warm-${bootId}-18446744073709551616`,
    `warm-${bootId}-123456789012345678901`
  ]) {
    assert.equal(validWarmJobId(id), false, id)
    assert.equal(isWarmJobSnapshot({ ...done, jobId: id }), false, id)
  }
})
