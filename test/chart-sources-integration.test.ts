import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChartSource, LngLatBbox, ZoomRange } from 'signalk-chart-sources'

const NOAA_SOURCE_IDS = ['depth-noaa-enc', 'depth-noaa-enc-quality'] as const
const OUTSIDE_NOAA_COVERAGE: LngLatBbox = [145, -40, 150, -35]
const WORLD: LngLatBbox = [-180, -85, 180, 85]
const COVERAGE_ZOOMS: ZoomRange = [5, 5]
const chartSources = import('signalk-chart-sources')

function sourceById (id: string, lookup: (id: string) => ChartSource | undefined): ChartSource {
  const source = lookup(id)
  assert.ok(source, `missing chart source ${id}`)
  return source
}

test('NOAA ENC regions outside catalog coverage count and estimate as zero', async () => {
  const { chartSourceById, estimateBytes, tileCountInBbox } = await chartSources
  for (const id of NOAA_SOURCE_IDS) {
    const source = sourceById(id, chartSourceById)
    assert.equal(tileCountInBbox(source, OUTSIDE_NOAA_COVERAGE, [5, 7]), 0)
    assert.equal(estimateBytes([id], OUTSIDE_NOAA_COVERAGE, [5, 7], {}), 0)
  }
})

test('NOAA ENC coverage produces nonzero estimates limited below its display envelope', async () => {
  const {
    chartSourceById,
    DEFAULT_TILE_BYTES,
    DEFAULT_TILE_BYTES_BY_MODE,
    estimateBytes,
    tileCountInBbox
  } = await chartSources
  for (const id of NOAA_SOURCE_IDS) {
    const source = sourceById(id, chartSourceById)
    const coveredTiles = tileCountInBbox(source, WORLD, COVERAGE_ZOOMS)
    const envelopeTiles = tileCountInBbox({ ...source, coverage: undefined }, WORLD, COVERAGE_ZOOMS)
    const estimate = estimateBytes([id], WORLD, COVERAGE_ZOOMS, {})

    assert.ok(coveredTiles > 0)
    assert.ok(coveredTiles < envelopeTiles, `${id} coverage must reduce the display-envelope count`)
    assert.ok(estimate > 0)
    assert.equal(
      estimate,
      coveredTiles * (source.fallbackTileBytes ?? DEFAULT_TILE_BYTES_BY_MODE[source.upstream.mode] ?? DEFAULT_TILE_BYTES)
    )
  }
})

test('signalk-chart-sources 0.5 counts duplicate source ids once', async () => {
  const { estimateBytes } = await chartSources
  const once = estimateBytes(['depth-noaa-enc'], WORLD, COVERAGE_ZOOMS, {})
  assert.equal(estimateBytes(['depth-noaa-enc', 'depth-noaa-enc'], WORLD, COVERAGE_ZOOMS, {}), once)
})
