/** Persists the prewarm box and the position-warm settings as a JSON state file under the Signal K data
 * directory. This is the single source of truth; the values are deliberately NOT in schema() or
 * savePluginOptions, so they never surface as a second input surface in the plugin config screen.
 * Persistence goes through the shared sync json-state helper so the prewarm store and the chart override
 * store use one idiom. */

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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

export type RegionStatus = 'downloading' | 'ready' | 'capped' | 'error' | 'needs-redownload'

export interface SavedRegion {
  id: string
  name: string
  bbox: [number, number, number, number]
  sourceIds: string[]
  minzoom: number
  maxzoom: number
  createdAt: number
  lastDownloadedAt: number | null
  bytes: number
  status: RegionStatus
}

export interface PrewarmStore {
  regions: SavedRegion[]
  positionWarm: PositionWarmSettings
}

export const DEFAULT_PREWARM_STORE: PrewarmStore = {
  regions: [],
  positionWarm: { ...DEFAULT_PREWARM_CONFIG.positionWarm }
}

/** The reserved pseudo-region id under which position-warm tiles are pinned. It is carved its own
 * slice P of the regions budget R (real regions gate against R - P), so position-warm neither
 * escapes nor starves the regions budget. It must match the container constant verbatim. */
export const POSITION_WARM_REGION_ID = '__position_warm__'

/** P, the position-warm reserve, derived from R: a small slice (10% of R, capped at 64 MiB). */
export function positionWarmBudgetBytes (regionsBudgetBytes: number): number {
  return Math.min(Math.floor(regionsBudgetBytes * 0.1), 64 * 1024 * 1024)
}

const STORE_FILE = 'prewarm.json'

/** Read the persisted config, falling back to the default on a missing or corrupt file. */
export function loadPrewarmConfig (dataDir: string): PrewarmConfig {
  const parsed = readJsonState<Partial<PrewarmConfig>>(join(dataDir, STORE_FILE), {})
  return {
    ...DEFAULT_PREWARM_CONFIG,
    ...parsed,
    positionWarm: { ...DEFAULT_PREWARM_CONFIG.positionWarm, ...(parsed.positionWarm ?? {}) }
  }
}

/** Write the config atomically enough for a single-writer plugin (one JSON file). */
export function savePrewarmConfig (dataDir: string, config: PrewarmConfig): void {
  writeJsonState(join(dataDir, STORE_FILE), config)
}

/** Detect a v2 shape (top-level `bbox` or `sources`), migrate to the regions list, write back, and
 * return the migrated store. Only called on first load of a v2 file; after write-back the file has
 * no v2 keys so subsequent loads skip migration. */
function migrateV2 (raw: Record<string, unknown>, dataDir: string): PrewarmStore {
  const regions: SavedRegion[] = []
  const rawBbox = raw['bbox']
  if (
    Array.isArray(rawBbox) &&
    rawBbox.length === 4 &&
    rawBbox.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    const rawSources = Array.isArray(raw['sources']) ? (raw['sources'] as string[]) : []
    const rawMinzoom = typeof raw['minzoom'] === 'number' ? raw['minzoom'] : 6
    const rawMaxzoom = typeof raw['maxzoom'] === 'number' ? raw['maxzoom'] : 12
    regions.push({
      id: randomUUID(),
      name: 'Downloaded region',
      bbox: rawBbox as [number, number, number, number],
      sourceIds: rawSources,
      minzoom: rawMinzoom,
      maxzoom: rawMaxzoom,
      createdAt: Math.floor(Date.now() / 1000),
      lastDownloadedAt: null,
      bytes: 0,
      status: 'needs-redownload'
    })
  }
  const rawPositionWarm = typeof raw['positionWarm'] === 'object' && raw['positionWarm'] !== null
    ? raw['positionWarm'] as Partial<PositionWarmSettings>
    : {}
  const store: PrewarmStore = {
    regions,
    positionWarm: { ...DEFAULT_PREWARM_STORE.positionWarm, ...rawPositionWarm }
  }
  writeJsonState(join(dataDir, STORE_FILE), store)
  return store
}

/** Read the persisted store, migrating a v2 box shape to a regions list if needed. Falls back to the
 * default on a missing or corrupt file. */
export function loadPrewarmStore (dataDir: string): PrewarmStore {
  const parsed = readJsonState<Record<string, unknown>>(join(dataDir, STORE_FILE), {})
  if ('bbox' in parsed || 'sources' in parsed) {
    return migrateV2(parsed, dataDir)
  }
  const rawRegions = Array.isArray(parsed['regions']) ? (parsed['regions'] as SavedRegion[]) : []
  const rawPositionWarm = typeof parsed['positionWarm'] === 'object' && parsed['positionWarm'] !== null
    ? parsed['positionWarm'] as Partial<PositionWarmSettings>
    : {}
  return {
    regions: rawRegions,
    positionWarm: { ...DEFAULT_PREWARM_STORE.positionWarm, ...rawPositionWarm }
  }
}

/** Write the store atomically enough for a single-writer plugin (one JSON file). */
export function savePrewarmStore (dataDir: string, store: PrewarmStore): void {
  writeJsonState(join(dataDir, STORE_FILE), store)
}
