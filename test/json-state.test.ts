import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preserveInvalidJsonState, readJsonState, sweepStaleJsonStateTemporaries, writeJsonState } from '../src/runtime/json-state.js'

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
  assert.equal(readdirSync(dir).some((name) => name.startsWith('x.json.corrupt-')), true)
})

test('a valid JSON value with the wrong root type is preserved and rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  const path = join(dir, 'x.json')
  writeFileSync(path, 'null')
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  assert.deepEqual(readJsonState(path, { ok: true }, { validate: isRecord }), { ok: true })
  assert.equal(readdirSync(dir).some((name) => name.startsWith('x.json.corrupt-')), true)
})

test('a failed replacement keeps the previous complete document and removes its temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  const path = join(dir, 'state.json')
  writeJsonState(path, { value: 'before' })
  assert.throws(() => writeJsonState(path, { impossible: 1n }))
  assert.deepEqual(readJsonState(path, {}), { value: 'before' })
  assert.deepEqual(readdirSync(dir), ['state.json'])
})

test('preserveInvalidJsonState can copy the original aside instead of moving it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  const path = join(dir, 'state.json')
  writeFileSync(path, '{"regions":"not-an-array"}')

  preserveInvalidJsonState(path, { keepOriginal: true })

  // The caller writes the normalized replacement next. Until that write lands, the only readable copy
  // has to stay under the expected name: a move here plus a failed write leaves no state file at all.
  assert.equal(readFileSync(path, 'utf8'), '{"regions":"not-an-array"}')
  const backup = readdirSync(dir).find((name) => name.startsWith('state.json.corrupt-'))
  assert.ok(backup)
  assert.equal(readFileSync(join(dir, backup), 'utf8'), '{"regions":"not-an-array"}')
})

test('an abandoned temporary file is reaped once it is older than the threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  const path = join(dir, 'state.json')
  writeJsonState(path, { value: 'live' })

  // A process killed between openSync and renameSync leaves one of these behind, and nothing else
  // ever removes it.
  const abandoned = join(dir, 'state.json.tmp-4242-1-abandoned')
  const fresh = join(dir, 'state.json.tmp-4243-2-fresh')
  const unrelated = join(dir, 'other.json.tmp-4244-3-unrelated')
  for (const file of [abandoned, fresh, unrelated]) writeFileSync(file, '{}')
  const old = new Date(Date.now() - 60 * 60_000)
  utimesSync(abandoned, old, old)
  utimesSync(unrelated, old, old)

  sweepStaleJsonStateTemporaries(path)

  const remaining = readdirSync(dir).sort()
  assert.deepEqual(remaining, ['other.json.tmp-4244-3-unrelated', 'state.json', 'state.json.tmp-4243-2-fresh'].sort())
  assert.ok(statSync(path).isFile())
})

test('a sweep on an unreadable directory is silent rather than failing the write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'json-state-'))
  assert.doesNotThrow(() => { sweepStaleJsonStateTemporaries(join(dir, 'absent', 'state.json')) })
})
