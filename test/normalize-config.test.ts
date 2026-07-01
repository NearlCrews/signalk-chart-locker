import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/panel/normalize-config.js'
import { commitNumberDraft } from '../src/panel/hooks/use-number-draft.js'

test('normalizeConfig yields the schema defaults for a never-configured plugin', () => {
  const config = normalizeConfig(null)
  assert.equal(config.tileCache.cacheCapGiB, 8)
  assert.equal(config.tileCache.regionsBudgetGiB, 0)
  assert.equal(config.charts.path, '')
  assert.equal(config.advanced.imageTag, '')
  assert.equal(config.advanced.cacheVolumeSource, '')
})

test('normalizeConfig clamps a cap below the minimum up to 4', () => {
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 2 } }).tileCache.cacheCapGiB, 4)
})

test('normalizeConfig snaps an off-grid cap to the nearest 4 GiB', () => {
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 6 } }).tileCache.cacheCapGiB, 8)
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 14 } }).tileCache.cacheCapGiB, 16)
})

test('normalizeConfig keeps the snapped cap within the maximum', () => {
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 32 } }).tileCache.cacheCapGiB, 32)
  assert.equal(normalizeConfig({ tileCache: { cacheCapGiB: 99999 } }).tileCache.cacheCapGiB, 32)
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
  const opts = { min: 4, max: 32, integer: true, step: 4 }
  assert.equal(commitNumberDraft('6', opts), 8)
  assert.equal(commitNumberDraft('13', opts), 12)
  assert.equal(commitNumberDraft('99', opts), 32) // snap then clamp to the max
  assert.equal(commitNumberDraft('', opts), 4) // empty falls back to min
})
