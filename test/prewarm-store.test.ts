import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPrewarmConfig, savePrewarmConfig, DEFAULT_PREWARM_CONFIG } from '../src/runtime/prewarm-store.js'

test('loadPrewarmConfig returns the default when no file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
  assert.deepEqual(loadPrewarmConfig(dir), DEFAULT_PREWARM_CONFIG)
})

test('saved config round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
  const cfg = { ...DEFAULT_PREWARM_CONFIG, bbox: [-10, 40, 10, 55] as [number, number, number, number], sources: ['seamark'], minzoom: 6, maxzoom: 10 }
  savePrewarmConfig(dir, cfg)
  assert.deepEqual(loadPrewarmConfig(dir), cfg)
})

test('a corrupt file falls back to the default rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
  writeFileSync(join(dir, 'prewarm.json'), 'not json')
  assert.deepEqual(loadPrewarmConfig(dir), DEFAULT_PREWARM_CONFIG)
})
