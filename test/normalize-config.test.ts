import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/panel/normalize-config.js'
import { commitNumberDraft } from '../src/panel/hooks/use-number-draft.js'

test('normalizeConfig yields the schema defaults for a never-configured plugin', () => {
  const config = normalizeConfig(null)
  assert.equal(config.tileCache.cacheCapGiB, 10)
  assert.equal(config.tileCache.regionsBudgetGiB, 0)
  assert.equal(config.charts.path, '')
  assert.equal(config.advanced.imageTag, '')
  assert.equal(config.advanced.cacheVolumeSource, '')
})

test('normalizeConfig clamps a cap below the minimum up to 5', () => {
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 2 } }).tileCache.cacheCapGiB, 5)
})

test('normalizeConfig snaps an off-grid cap to the nearest 5 GiB', () => {
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 8 } }).tileCache.cacheCapGiB, 10)
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 97 } }).tileCache.cacheCapGiB, 95)
})

test('normalizeConfig keeps the snapped cap within the maximum', () => {
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 1024 } }).tileCache.cacheCapGiB, 1024)
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 99999 } }).tileCache.cacheCapGiB, 1024)
})

test('normalizeConfig trims string fields and clamps a negative regions budget to 0', () => {
  const config = normalizeConfig({
    tileCache: { regionsBudgetGiB: -5 },
    charts: { path: '  charts/pmtiles  ' },
    advanced: { imageTag: ' v1.2.3 ', cacheVolumeSource: ' /mnt/ssd ' }
  })
  assert.equal(config.tileCache.regionsBudgetGiB, 0)
  assert.equal(config.charts.path, 'charts/pmtiles')
  assert.equal(config.advanced.imageTag, 'v1.2.3')
  assert.equal(config.advanced.cacheVolumeSource, '/mnt/ssd')
})

test('commitNumberDraft snaps a typed cap to the step and stays within the bounds', () => {
  const opts = { min: 5, max: 1024, integer: true, step: 5 }
  assert.equal(commitNumberDraft('7', opts), 5)
  assert.equal(commitNumberDraft('13', opts), 15)
  assert.equal(commitNumberDraft('1024', opts), 1024) // snap to 1025 then clamp to 1024
  assert.equal(commitNumberDraft('', opts), 5) // empty falls back to min
})
