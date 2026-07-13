import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonState, writeJsonState } from '../src/runtime/json-state.js'

test('readJsonState returns the fallback when the file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  assert.deepEqual(readJsonState(join(dir, 'x.json'), { a: 1 }), { a: 1 })
})

test('writeJsonState then readJsonState round-trips, creating the parent directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  const path = join(dir, 'nested', 'x.json')
  writeJsonState(path, { a: 2, b: ['c'] })
  assert.deepEqual(readJsonState(path, {}), { a: 2, b: ['c'] })
})

test('a corrupt file falls back rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  const path = join(dir, 'x.json')
  writeFileSync(path, 'not json')
  assert.deepEqual(readJsonState(path, { ok: true }), { ok: true })
})

test('a failed replacement keeps the previous complete document and removes its temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  const path = join(dir, 'state.json')
  writeJsonState(path, { value: 'before' })
  assert.throws(() => writeJsonState(path, { impossible: 1n }))
  assert.deepEqual(readJsonState(path, {}), { value: 'before' })
  assert.deepEqual(readdirSync(dir), ['state.json'])
})
