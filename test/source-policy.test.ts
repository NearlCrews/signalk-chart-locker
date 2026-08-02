import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChartSource } from 'signalk-chart-sources'
import { isTimeDynamicSource, isWarmableSource, timeDynamicSourceIds, warmableSourceIds } from '../src/charts/source-policy.js'

const chartSources = import('signalk-chart-sources')

function source (over: Partial<ChartSource> = {}): ChartSource {
  return {
    id: 'static-source',
    title: 'Static',
    upstream: { mode: 'xyz', urlTemplate: 'https://example.test/{z}/{x}/{y}.png' },
    tileSize: 256,
    minzoom: 0,
    maxzoom: 18,
    attribution: '',
    ...over
  }
}

function lookupOver (sources: ChartSource[]): (id: string) => ChartSource | undefined {
  const byId = new Map(sources.map((entry) => [entry.id, entry]))
  return (id) => byId.get(id)
}

test('a declared tile lifetime marks a source time-dynamic and unwarmable', () => {
  const weather = source({ id: 'weather', maxAgeSeconds: 300 })
  assert.equal(isTimeDynamicSource(weather), true)
  assert.equal(isWarmableSource(weather), false)
})

test('a source with no declared lifetime is warmable', () => {
  const chart = source()
  assert.equal(isTimeDynamicSource(chart), false)
  assert.equal(isWarmableSource(chart), true)
})

test('warmableSourceIds drops time-dynamic and unknown ids and keeps the given order', () => {
  const lookup = lookupOver([
    source({ id: 'chart-a' }),
    source({ id: 'weather-a', maxAgeSeconds: 300 }),
    source({ id: 'chart-b' })
  ])
  assert.deepEqual(warmableSourceIds(['chart-b', 'weather-a', 'gone', 'chart-a'], lookup), ['chart-b', 'chart-a'])
})

test('timeDynamicSourceIds names only the excluded catalog entries', () => {
  const lookup = lookupOver([
    source({ id: 'chart-a' }),
    source({ id: 'weather-a', maxAgeSeconds: 300 }),
    source({ id: 'ocean-a', maxAgeSeconds: 21_600 })
  ])
  assert.deepEqual(timeDynamicSourceIds(['chart-a', 'weather-a', 'gone', 'ocean-a'], lookup), ['weather-a', 'ocean-a'])
})

test('an all-time-dynamic selection warms nothing rather than part of itself', () => {
  const lookup = lookupOver([source({ id: 'weather-a', maxAgeSeconds: 300 })])
  assert.deepEqual(warmableSourceIds(['weather-a'], lookup), [])
})

// The exact set the plugin refuses to warm, written out rather than recomputed. A catalog bump that
// gives a source a lifetime changes what Chart Locker will store, so it has to be a deliberate edit
// here, not a silent change in behavior. Adding an entry means confirming the source really is
// time-dynamic; losing one means confirming it really did become static.
const TIME_DYNAMIC_CATALOG_IDS = [
  'weather-radar-conus',
  'weather-radar-alaska',
  'weather-radar-hawaii',
  'weather-radar-caribbean',
  'weather-tropical',
  'weather-alerts-us',
  'ocean-sst-global'
]

test('the catalog declares a lifetime on exactly the known time-dynamic sources', async () => {
  const { CHART_SOURCES } = await chartSources
  assert.deepEqual(
    CHART_SOURCES.filter((entry) => entry.maxAgeSeconds !== undefined).map((entry) => entry.id).sort(),
    [...TIME_DYNAMIC_CATALOG_IDS].sort()
  )
})

test('the policy excludes exactly the catalog sources that declare a lifetime', async () => {
  const { CHART_SOURCES, chartSourceById } = await chartSources
  const allIds = CHART_SOURCES.map((entry) => entry.id)
  const declaresLifetime = CHART_SOURCES.filter((entry) => entry.maxAgeSeconds !== undefined).map((entry) => entry.id)

  assert.ok(declaresLifetime.length > 0, 'the catalog must still carry at least one time-dynamic source')
  assert.deepEqual(timeDynamicSourceIds(allIds, chartSourceById), declaresLifetime)
  assert.deepEqual(
    warmableSourceIds(allIds, chartSourceById),
    allIds.filter((id) => !declaresLifetime.includes(id))
  )
  // The contract also caps every time-dynamic source well below the chart-display ceiling, because a
  // source that re-fetches on a timer pays its tile count over and over.
  for (const id of declaresLifetime) {
    const entry = chartSourceById(id)
    assert.ok(entry, `missing chart source ${id}`)
    assert.ok(entry.maxzoom <= 12, `${id} must keep a low zoom ceiling`)
  }
})
