import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configReducer } from '../src/panel/config-reducer.js'
import { saveButtonDisabled } from '../src/panel/footer-bar-state.js'
import { relativeTime } from '../src/panel/relative-time.js'
import type { ChartLockerConfig } from '../src/panel/config-types.js'

function baseConfig (): ChartLockerConfig {
  return {
    tileCache: { cacheCapGiB: 8, regionsBudgetGiB: 0 },
    charts: { path: '' },
    advanced: { imageTag: '', cacheVolumeSource: '' }
  }
}

test('configReducer returns the same object identity on a no-op change', () => {
  const state = baseConfig()
  const same = configReducer(state, { type: 'setCacheCapGiB', giB: 8 })
  assert.equal(same, state, 'setting a field to its current value must not allocate a new object')
})

test('configReducer returns a new object only for the changed group', () => {
  const state = baseConfig()
  const next = configReducer(state, { type: 'setCacheCapGiB', giB: 12 })
  assert.notEqual(next, state)
  assert.notEqual(next.tileCache, state.tileCache, 'the changed group is rebuilt')
  assert.equal(next.charts, state.charts, 'an untouched group keeps its identity')
  assert.equal(next.tileCache.cacheCapGiB, 12)
})

test('configReducer discard replaces the whole state with the given config', () => {
  const state = baseConfig()
  const restored = baseConfig()
  assert.equal(configReducer(state, { type: 'discard', config: restored }), restored)
})

test('saveButtonDisabled: disabled only when clean and already configured', () => {
  assert.equal(saveButtonDisabled(false, false), true, 'clean and configured: disabled')
  assert.equal(saveButtonDisabled(true, false), false, 'dirty: enabled')
  assert.equal(saveButtonDisabled(false, true), false, 'unconfigured: enabled')
  assert.equal(saveButtonDisabled(true, true), false, 'dirty and unconfigured: enabled')
})

test('relativeTime steps up to the coarser unit at the rounding boundary', () => {
  // 3599 seconds rounds to one hour, not 60 minutes.
  assert.match(relativeTime(Date.now() - 3599 * 1000), /hour/)
  // A few seconds stays in seconds.
  assert.match(relativeTime(Date.now() - 5 * 1000), /second/)
})
