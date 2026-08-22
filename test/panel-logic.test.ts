import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configReducer } from '../src/panel/config-reducer.js'
import { saveButtonDisabled } from '../src/panel/footer-bar-state.js'
import { formatBytes, splitBytes } from '../src/panel/format-bytes.js'
import { isTeardownAbort } from '../src/panel/hooks/use-abortable-fetch.js'
import type { ChartLockerConfig } from '../src/panel/config-types.js'
import { validatePanelConfig } from '../src/panel/validate-config.js'
import { parseCacheStats } from '../src/panel/hooks/use-cache-operations.js'
import { parseChartDiscovery } from '../src/panel/hooks/use-chart-discovery.js'
import { MAX_CONFIG_PATH_LENGTH } from '../src/shared/config-path.js'

function baseConfig (): ChartLockerConfig {
  return {
    tileCache: { cacheCapGiB: 8, regionsBudgetGiB: 0 },
    charts: { path: '' },
    advanced: { geocodingEnabled: true, imageTag: '', cacheVolumeSource: '' }
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

test('configReducer changes the geocoding setting without rebuilding other groups', () => {
  const state = baseConfig()
  const next = configReducer(state, { type: 'setGeocodingEnabled', enabled: false })
  assert.notEqual(next.advanced, state.advanced)
  assert.equal(next.tileCache, state.tileCache)
  assert.equal(next.advanced.geocodingEnabled, false)
})

test('saveButtonDisabled: disabled only when clean and already configured', () => {
  assert.equal(saveButtonDisabled(false, false), true, 'clean and configured: disabled')
  assert.equal(saveButtonDisabled(true, false), false, 'dirty: enabled')
  assert.equal(saveButtonDisabled(false, true), false, 'unconfigured: enabled')
  assert.equal(saveButtonDisabled(true, true), false, 'dirty and unconfigured: enabled')
})

test('a teardown abort is distinguished from a request that ran out of time', () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal(isTeardownAbort(controller.signal.reason), true, 'an unmount abort must stay silent')
  assert.equal(
    isTeardownAbort(new DOMException('timed out', 'TimeoutError')),
    false,
    'a timeout is a failure the operator needs to see'
  )
  assert.equal(isTeardownAbort(new Error('HTTP 503')), false)
  assert.equal(isTeardownAbort(null), false)
})

test('byte formatting picks binary units and reports an unknown count', () => {
  assert.deepEqual(splitBytes(null), { value: 'Unknown' })
  assert.deepEqual(splitBytes(2048), { value: '2', unit: 'KiB' })
  assert.deepEqual(splitBytes(700 * 1024 ** 2), { value: '700.0', unit: 'MiB' })
  assert.deepEqual(splitBytes(8 * 1024 ** 3), { value: '8.0', unit: 'GiB' })
  // The last KiB before the MiB threshold stays in KiB rather than rounding into it.
  assert.deepEqual(splitBytes(1024 ** 2 - 1), { value: '1024', unit: 'KiB' })
  assert.equal(formatBytes(700 * 1024 ** 2), '700.0 MiB')
  assert.equal(formatBytes(null), 'Unknown')
})

test('panel validation matches the runtime path text bounds', () => {
  const state = baseConfig()
  state.charts.path = `charts/${'x'.repeat(MAX_CONFIG_PATH_LENGTH)}`
  state.advanced.cacheVolumeSource = '/media/\u2028bad'
  const validation = validatePanelConfig(state)
  assert.match(validation.chartsPath ?? '', /at most 4096 characters/)
  assert.match(validation.cacheVolumeSource ?? '', /control characters/)
})

test('parseCacheStats rejects malformed nested container data', () => {
  const valid = {
    rows: 1,
    bytes: 2,
    cap: 3,
    pinnedBytes: 1,
    scrollBytes: 1,
    regionsBudgetBytes: 2,
    regionsFreeBytes: 1,
    positionWarmBytes: 0,
    availableBytes: null,
    minimumHeadroomBytes: 1,
    diskPressure: false,
    configured: true,
    ttlDays: 30,
    bySource: [{ source: 'source', bytes: 2, rows: 1 }],
    upstream: { source: { slow: false, timeoutSecs: 15, lastTimeoutAt: 0 } },
    diagnostics: {
      diskPressureEvents: 0,
      warmRejections: 0,
      configPushes: 1,
      cacheOperationErrors: 0
    }
  }
  assert.equal(parseCacheStats(valid).bySource[0]?.source, 'source')
  assert.equal(parseCacheStats({ ...valid, diskPressure: null }).diskPressure, null)
  assert.throws(
    () => parseCacheStats({ ...valid, bySource: [null] }),
    /bySource\[0\] must be an object/
  )
  assert.throws(
    () => parseCacheStats({ ...valid, upstream: { source: { slow: 'no' } } }),
    /must be a health object/
  )
})

test('parseChartDiscovery rejects malformed diagnostics instead of crashing the panel', () => {
  const valid = {
    charts: [{ id: 'one' }],
    invalid: [{ fileName: 'bad.pmtiles', error: 'invalid header' }],
    discovery: { lastScanAt: 1 }
  }
  assert.deepEqual(parseChartDiscovery(valid), {
    valid: 1,
    invalid: [{ fileName: 'bad.pmtiles', error: 'invalid header' }],
    lastScanAt: 1
  })
  assert.throws(
    () => parseChartDiscovery({ ...valid, invalid: [null] }),
    /invalid\[0\] must be an object/
  )
})
