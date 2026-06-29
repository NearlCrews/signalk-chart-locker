/** Persists the saved map regions and the position-warm settings as a JSON state file under the Signal K data
 * directory. This is the single source of truth; the values are deliberately NOT in schema() or
 * savePluginOptions, so they never surface as a second input surface in the plugin config screen.
 * Persistence goes through the shared sync json-state helper so the regions store and the chart override
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

export interface RegionsStore {
  regions: SavedRegion[]
  positionWarm: PositionWarmSettings
  cacheScrollTtlDays: number
}

/** Position-warm defaults: OFF (opt-in), a 2 nm radius, a 1 nm move threshold, a 60 s interval, base zoom 12. */
export const DEFAULT_REGIONS_STORE: RegionsStore = {
  regions: [],
  positionWarm: {
    enabled: false,
    radiusMeters: 3704,
    moveThresholdMeters: 1852,
    intervalSecs: 60,
    baseZoom: 12,
    sources: []
  },
  cacheScrollTtlDays: 30
}

/** The reserved pseudo-region id under which position-warm tiles are pinned. It is carved its own
 * slice P of the regions budget R (real regions gate against R - P), so position-warm neither
 * escapes nor starves the regions budget. It must match the container constant verbatim. */
export const POSITION_WARM_REGION_ID = '__position_warm__'

/** P, the position-warm reserve, derived from R: a small slice (10% of R, capped at 64 MiB). */
export function positionWarmBudgetBytes (regionsBudgetBytes: number): number {
  return Math.min(Math.floor(regionsBudgetBytes * 0.1), 64 * 1024 * 1024)
}

const STORE_FILE = 'regions.json'

/** Detect a v2 shape (top-level `bbox` or `sources`), migrate to the regions list, write back, and
 * return the migrated store. Only called on first load of a v2 file; after write-back the file has
 * no v2 keys so subsequent loads skip migration. */
function migrateV2 (raw: Record<string, unknown>, dataDir: string): RegionsStore {
  // Defense in depth: an existing regions array is the base, so a stray top-level bbox or sources key
  // can never discard saved regions. The legacy single box becomes one region only when there is no
  // existing regions array. The write-back stores only regions and positionWarm, so the top-level
  // bbox, sources, minzoom, and maxzoom are dropped either way.
  const hasRegions = Array.isArray(raw['regions'])
  const regions: SavedRegion[] = hasRegions ? (raw['regions'] as SavedRegion[]) : []
  const rawBbox = raw['bbox']
  if (
    !hasRegions &&
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
  const rawTtl = typeof raw['cacheScrollTtlDays'] === 'number' ? raw['cacheScrollTtlDays'] : DEFAULT_REGIONS_STORE.cacheScrollTtlDays
  const store: RegionsStore = {
    regions,
    positionWarm: { ...DEFAULT_REGIONS_STORE.positionWarm, ...rawPositionWarm },
    cacheScrollTtlDays: rawTtl
  }
  writeJsonState(join(dataDir, STORE_FILE), store)
  return store
}

/** Read the persisted store, migrating a v2 box shape to a regions list if needed. Falls back to the
 * default on a missing or corrupt file. */
export function loadRegionsStore (dataDir: string): RegionsStore {
  const parsed = readJsonState<Record<string, unknown>>(join(dataDir, STORE_FILE), {})
  if ('bbox' in parsed || 'sources' in parsed) {
    return migrateV2(parsed, dataDir)
  }
  const rawRegions = Array.isArray(parsed['regions']) ? (parsed['regions'] as SavedRegion[]) : []
  const rawPositionWarm = typeof parsed['positionWarm'] === 'object' && parsed['positionWarm'] !== null
    ? parsed['positionWarm'] as Partial<PositionWarmSettings>
    : {}
  const rawTtl = typeof parsed['cacheScrollTtlDays'] === 'number' ? parsed['cacheScrollTtlDays'] : DEFAULT_REGIONS_STORE.cacheScrollTtlDays
  return {
    regions: rawRegions,
    positionWarm: { ...DEFAULT_REGIONS_STORE.positionWarm, ...rawPositionWarm },
    cacheScrollTtlDays: rawTtl
  }
}

/** Write the store atomically enough for a single-writer plugin (one JSON file). */
export function saveRegionsStore (dataDir: string, store: RegionsStore): void {
  writeJsonState(join(dataDir, STORE_FILE), store)
}

/** Append a region to the persisted store and write it back. */
export function addRegion (dataDir: string, region: SavedRegion): void {
  const store = loadRegionsStore(dataDir)
  store.regions.push(region)
  saveRegionsStore(dataDir, store)
}

/** Patch a region in place by id and write the store back; a no-op when the id is absent. */
export function updateRegion (dataDir: string, id: string, patch: Partial<SavedRegion>): void {
  const store = loadRegionsStore(dataDir)
  const idx = store.regions.findIndex((r) => r.id === id)
  if (idx >= 0) store.regions[idx] = { ...store.regions[idx]!, ...patch }
  saveRegionsStore(dataDir, store)
}

/** Drop a region by id from the persisted store and write it back. */
export function removeRegion (dataDir: string, id: string): void {
  const store = loadRegionsStore(dataDir)
  store.regions = store.regions.filter((r) => r.id !== id)
  saveRegionsStore(dataDir, store)
}

/** The persisted regions list. */
export function listRegions (dataDir: string): SavedRegion[] {
  return loadRegionsStore(dataDir).regions
}
