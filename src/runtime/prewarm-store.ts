/** Persists the prewarm box and the position-warm settings as a JSON state file under the Signal K data
 * directory. This is the single source of truth; the values are deliberately NOT in schema() or
 * savePluginOptions, so they never surface as a second input surface in the plugin config screen.
 * Persistence goes through the shared sync json-state helper so the prewarm store and the chart override
 * store use one idiom. */

import { join } from 'node:path'
import { readJsonState, writeJsonState } from './json-state.js'

export interface PositionWarmSettings {
  enabled: boolean
  radiusMeters: number
  moveThresholdMeters: number
  intervalSecs: number
  baseZoom: number
  sources: string[]
}

export interface PrewarmConfig {
  bbox: [number, number, number, number] | null
  sources: string[]
  minzoom: number
  maxzoom: number
  positionWarm: PositionWarmSettings
}

/** Defaults: position-warm OFF (opt-in), a 2 nm radius, a 1 nm move threshold, a 60 s interval, base zoom 12. */
export const DEFAULT_PREWARM_CONFIG: PrewarmConfig = {
  bbox: null,
  sources: [],
  minzoom: 6,
  maxzoom: 12,
  positionWarm: {
    enabled: false,
    radiusMeters: 3704,
    moveThresholdMeters: 1852,
    intervalSecs: 60,
    baseZoom: 12,
    sources: []
  }
}

const FILE = 'prewarm.json'

/** Read the persisted config, falling back to the default on a missing or corrupt file. */
export function loadPrewarmConfig (dataDir: string): PrewarmConfig {
  const parsed = readJsonState<Partial<PrewarmConfig>>(join(dataDir, FILE), {})
  return {
    ...DEFAULT_PREWARM_CONFIG,
    ...parsed,
    positionWarm: { ...DEFAULT_PREWARM_CONFIG.positionWarm, ...(parsed.positionWarm ?? {}) }
  }
}

/** Write the config atomically enough for a single-writer plugin (one JSON file). */
export function savePrewarmConfig (dataDir: string, config: PrewarmConfig): void {
  writeJsonState(join(dataDir, FILE), config)
}
