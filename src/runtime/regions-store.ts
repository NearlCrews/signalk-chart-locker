/** Persists the saved map regions and the position-warm settings as a JSON state file under the Signal K data
 * directory. This is the single source of truth; the values are deliberately NOT in schema() or
 * savePluginOptions, so they never surface as a second input surface in the plugin config screen.
 * Persistence goes through the shared sync json-state helper so the regions store and the chart override
 * store use one idiom. */

import { join } from 'node:path'
import { statSync, watch, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { LngLatBbox } from 'signalk-chart-sources'
import { preserveInvalidJsonState, readJsonState, writeJsonState } from './json-state.js'
import { nowUnixSecs } from '../shared/time.js'
import { hasControlCharacter, normalizePrintableText } from '../shared/text.js'

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
  bbox: LngLatBbox
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

/** Position-warm defaults: ON out of the box but with NO charts picked, a 2 nm radius, a 1 nm move
 * threshold, a 60 s interval, and base zoom 12. Enabled-with-no-sources warms nothing yet: the panel
 * surfaces auto-cache as on and prompts the navigator to choose which charts to cache around the
 * boat, so the choice (and its bandwidth) is theirs rather than a silent default download. */
export const DEFAULT_REGIONS_STORE: RegionsStore = {
  regions: [],
  positionWarm: {
    enabled: true,
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

/** P is 10% of the regions budget R, so it scales with R but stays a small slice. */
const POSITION_WARM_BUDGET_FRACTION = 0.1
/** P is capped at 64 MiB so a large R does not hand the scrolling position-warm an oversized reserve. */
const POSITION_WARM_BUDGET_CAP_BYTES = 64 * 1024 * 1024

/** P, the position-warm reserve, derived from R: a small slice (10% of R, capped at 64 MiB). */
export function positionWarmBudgetBytes (regionsBudgetBytes: number): number {
  if (!Number.isFinite(regionsBudgetBytes) || regionsBudgetBytes <= 0) return 0
  return Math.min(Math.floor(regionsBudgetBytes * POSITION_WARM_BUDGET_FRACTION), POSITION_WARM_BUDGET_CAP_BYTES)
}

const STORE_FILE = 'regions.json'
export const MAX_WARM_ZOOM = 24
const MAX_SOURCE_IDS = 64
const MAX_SOURCE_ID_LENGTH = 256
export const MAX_REGION_ID_LENGTH = 128
export const MAX_SAVED_REGIONS = 128
export const MAX_REGION_TOTAL_ENTRIES = MAX_SAVED_REGIONS + 8
const REGION_STATUSES = new Set<RegionStatus>(['downloading', 'ready', 'capped', 'error', 'needs-redownload'])

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validBbox (value: unknown): value is LngLatBbox {
  return Array.isArray(value) && value.length === 4 &&
    value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) &&
    value[0] >= -180 && value[0] <= 180 && value[2] >= -180 && value[2] <= 180 &&
    value[1] >= -90 && value[1] <= 90 && value[3] >= -90 && value[3] <= 90 &&
    value[0] !== value[2] && !(value[0] > value[2] && Math.abs(value[0] - value[2]) === 360) && value[1] < value[3]
}

function validSources (value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_SOURCE_IDS &&
    value.every((source) => typeof source === 'string' && source.trim() === source && source.length > 0 &&
      source.length <= MAX_SOURCE_ID_LENGTH && !hasControlCharacter(source)) &&
    new Set(value).size === value.length
}

function finiteBetween (value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function normalizePositionWarm (value: unknown): PositionWarmSettings {
  const raw = isRecord(value) ? value : {}
  const defaults = DEFAULT_REGIONS_STORE.positionWarm
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    radiusMeters: finiteBetween(raw.radiusMeters, 1, 100_000) ? raw.radiusMeters : defaults.radiusMeters,
    moveThresholdMeters: finiteBetween(raw.moveThresholdMeters, 0, 100_000) ? raw.moveThresholdMeters : defaults.moveThresholdMeters,
    intervalSecs: finiteBetween(raw.intervalSecs, 60, 86_400) ? raw.intervalSecs : defaults.intervalSecs,
    baseZoom: typeof raw.baseZoom === 'number' && Number.isInteger(raw.baseZoom) && raw.baseZoom >= 0 && raw.baseZoom <= MAX_WARM_ZOOM
      ? raw.baseZoom
      : defaults.baseZoom,
    sources: validSources(raw.sources) ? [...raw.sources] : [...defaults.sources]
  }
}

function parseRegionState (raw: unknown, ids: Set<string>): SavedRegion | undefined {
  if (!isRecord(raw)) return undefined
  const name = normalizePrintableText(raw.name, 120)
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > MAX_REGION_ID_LENGTH || hasControlCharacter(raw.id) || ids.has(raw.id) ||
      name === undefined ||
      !validBbox(raw.bbox) || !validSources(raw.sourceIds) || raw.sourceIds.length === 0 ||
      typeof raw.minzoom !== 'number' || !Number.isInteger(raw.minzoom) || raw.minzoom < 0 || raw.minzoom > MAX_WARM_ZOOM ||
      typeof raw.maxzoom !== 'number' || !Number.isInteger(raw.maxzoom) || raw.maxzoom < raw.minzoom || raw.maxzoom > MAX_WARM_ZOOM ||
      !finiteBetween(raw.createdAt, 0, Number.MAX_SAFE_INTEGER) || !Number.isInteger(raw.createdAt) ||
      !(raw.lastDownloadedAt === null || (finiteBetween(raw.lastDownloadedAt, 0, Number.MAX_SAFE_INTEGER) && Number.isInteger(raw.lastDownloadedAt))) ||
      !finiteBetween(raw.bytes, 0, Number.MAX_SAFE_INTEGER) || !Number.isInteger(raw.bytes) ||
      typeof raw.status !== 'string' || !REGION_STATUSES.has(raw.status as RegionStatus)) return undefined
  ids.add(raw.id)
  return {
    id: raw.id,
    name,
    bbox: raw.bbox,
    sourceIds: [...raw.sourceIds],
    minzoom: raw.minzoom,
    maxzoom: raw.maxzoom,
    createdAt: raw.createdAt,
    lastDownloadedAt: raw.lastDownloadedAt,
    bytes: raw.bytes,
    status: raw.status as RegionStatus
  }
}

function normalizeRegions (value: unknown): SavedRegion[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const regions: SavedRegion[] = []
  for (const raw of value) {
    if (regions.length >= MAX_SAVED_REGIONS) break
    const region = parseRegionState(raw, ids)
    if (region !== undefined) regions.push(region)
  }
  return regions
}

function normalizeTtlDays (value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365
    ? value
    : DEFAULT_REGIONS_STORE.cacheScrollTtlDays
}

function validPositionWarmState (value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.radiusMeters === undefined || finiteBetween(value.radiusMeters, 1, 100_000)) &&
    (value.moveThresholdMeters === undefined || finiteBetween(value.moveThresholdMeters, 0, 100_000)) &&
    (value.intervalSecs === undefined || finiteBetween(value.intervalSecs, 60, 86_400)) &&
    (value.baseZoom === undefined || (typeof value.baseZoom === 'number' && Number.isInteger(value.baseZoom) && value.baseZoom >= 0 && value.baseZoom <= MAX_WARM_ZOOM)) &&
    (value.sources === undefined || validSources(value.sources))
}

function hasSemanticCorruption (raw: Record<string, unknown>): boolean {
  const regions = raw.regions
  if (regions !== undefined) {
    if (!Array.isArray(regions) || regions.length > MAX_SAVED_REGIONS) return true
    const ids = new Set<string>()
    if (!regions.every((region) => parseRegionState(region, ids) !== undefined)) return true
  }
  if (!validPositionWarmState(raw.positionWarm)) return true
  return raw.cacheScrollTtlDays !== undefined && normalizeTtlDays(raw.cacheScrollTtlDays) !== raw.cacheScrollTtlDays
}

/** Detect a v2 shape (top-level `bbox` or `sources`), migrate to the regions list, write back, and
 * return the migrated store. Only called on first load of a v2 file; after write-back the file has
 * no v2 keys so subsequent loads skip migration. */
function migrateV2 (raw: Record<string, unknown>, dataDir: string): RegionsStore {
  // Defense in depth: an existing regions array is the base, so a stray top-level bbox or sources key
  // can never discard saved regions. The legacy single box becomes one region only when there is no
  // existing regions array. The write-back stores only regions and positionWarm, so the top-level
  // bbox, sources, minzoom, and maxzoom are dropped either way.
  const hasRegions = Array.isArray(raw['regions'])
  const regions = hasRegions ? normalizeRegions(raw['regions']) : []
  const rawBbox = raw['bbox']
  if (
    !hasRegions && validBbox(rawBbox) && validSources(raw['sources']) && raw['sources'].length > 0
  ) {
    const rawSources = raw['sources']
    const rawMinzoom = typeof raw['minzoom'] === 'number' && Number.isInteger(raw['minzoom']) && raw['minzoom'] >= 0 && raw['minzoom'] <= MAX_WARM_ZOOM ? raw['minzoom'] : 6
    const rawMaxzoom = typeof raw['maxzoom'] === 'number' && Number.isInteger(raw['maxzoom']) && raw['maxzoom'] >= rawMinzoom && raw['maxzoom'] <= MAX_WARM_ZOOM ? raw['maxzoom'] : 12
    regions.push({
      id: randomUUID(),
      name: 'Downloaded region',
      bbox: rawBbox,
      sourceIds: [...rawSources],
      minzoom: rawMinzoom,
      maxzoom: rawMaxzoom,
      createdAt: nowUnixSecs(),
      lastDownloadedAt: null,
      bytes: 0,
      status: 'needs-redownload'
    })
  }
  const store: RegionsStore = {
    regions,
    positionWarm: normalizePositionWarm(raw['positionWarm']),
    cacheScrollTtlDays: normalizeTtlDays(raw['cacheScrollTtlDays'])
  }
  writeJsonState(join(dataDir, STORE_FILE), store)
  return store
}

/** Read the persisted store, migrating a v2 box shape to a regions list if needed. Falls back to the
 * default on a missing or corrupt file. */
export function loadRegionsStore (dataDir: string): RegionsStore {
  const file = join(dataDir, STORE_FILE)
  const parsed = readJsonState<Record<string, unknown>>(file, {}, { validate: isRecord })
  const semanticCorruption = hasSemanticCorruption(parsed)
  if (semanticCorruption) preserveInvalidJsonState(file)
  if ('bbox' in parsed || 'sources' in parsed) {
    return migrateV2(parsed, dataDir)
  }
  const store = {
    regions: normalizeRegions(parsed['regions']),
    positionWarm: normalizePositionWarm(parsed['positionWarm']),
    cacheScrollTtlDays: normalizeTtlDays(parsed['cacheScrollTtlDays'])
  }
  // Keep the original beside a normalized replacement, so future mutations cannot erase valid entries
  // merely because one sibling entry was malformed.
  if (semanticCorruption) writeJsonState(file, store)
  return store
}

/** A cached regions loader with a stop handle for its filesystem watcher. */
export interface CachedRegionsLoader {
  /** The current store, served from cache between writes. */
  getStore: () => RegionsStore
  /** Tear down the watcher. Idempotent. */
  stop: () => void
}

/** The self-heal cadence: even with the watcher, getStore re-stats at most this often so a dropped
 * fs.watch event converges instead of leaving the cache stale until the next write. */
const REGIONS_SELF_HEAL_MS = 5000

interface CachedRegionsLoaderOptions {
  selfHealMs?: number
  watch?: boolean
  now?: () => number
  statIdentity?: () => string
}

/** A loader that caches the parsed store so the position-warm loop, which calls getStore on every
 * navigation.position delta, does not read and parse the file per fix. An fs.watch on the data directory
 * marks the cache dirty on a write, so getStore does no I/O between writes; a throttled mtime re-stat
 * self-heals a dropped watch event (this project has seen fs.watch drop events on some platforms), and
 * is also the sole mechanism when the watcher cannot be established. Falls back to the store defaults
 * when the file is missing. Call stop() at plugin teardown to close the watcher. */
export function createCachedRegionsLoader (dataDir: string, options: CachedRegionsLoaderOptions = {}): CachedRegionsLoader {
  const file = join(dataDir, STORE_FILE)
  let cached: RegionsStore | null = null
  let cachedIdentity = '<not-loaded>'
  let dirty = true
  let lastStatMs = Number.NEGATIVE_INFINITY
  let watcher: FSWatcher | null = null

  // Watch the directory, not the file: regions.json may not exist yet, and an atomic rename-replace is
  // only observable at the directory level. A null filename (some platforms omit it) is treated as a
  // possible change to be safe.
  // Native events are reliable on the Linux deployment target. On other platforms the throttled
  // stat below is the sole invalidation mechanism, avoiding delayed macOS events and a Node 24
  // Windows watcher assertion during teardown.
  if (options.watch !== false && process.platform === 'linux') {
    try {
      watcher = watch(dataDir, (_event, filename) => {
        if (filename === null || filename === STORE_FILE) dirty = true
      })
      watcher.unref()
      // An unhandled watcher error would throw; on error, drop the watcher and rely on the self-heal stat.
      watcher.on('error', () => { if (watcher !== null) { watcher.close(); watcher = null } })
    } catch {
      watcher = null
    }
  }

  const reload = (identity: string): RegionsStore => {
    cached = loadRegionsStore(dataDir)
    cachedIdentity = identity
    dirty = false
    return cached
  }

  const statIdentity = options.statIdentity ?? ((): string => {
    try {
      const info = statSync(file, { bigint: true })
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`
    } catch {
      return '<missing>'
    }
  })

  return {
    getStore (): RegionsStore {
      const now = (options.now ?? Date.now)()
      if (dirty || cached === null) {
        lastStatMs = now
        return reload(statIdentity())
      }
      // Self-heal: re-stat at most once per interval so a missed watch event, or a run with no watcher,
      // still converges without doing I/O on every delta.
      if (now - lastStatMs >= (options.selfHealMs ?? REGIONS_SELF_HEAL_MS)) {
        lastStatMs = now
        const identity = statIdentity()
        if (identity !== cachedIdentity) return reload(identity)
      }
      return cached
    },
    stop (): void {
      if (watcher !== null) {
        watcher.close()
        watcher = null
      }
    }
  }
}

/** Write the store atomically for the plugin-owned JSON file. */
export function saveRegionsStore (dataDir: string, store: RegionsStore): void {
  writeJsonState(join(dataDir, STORE_FILE), store)
}

/**
 * Run one synchronous read-modify-write transaction. JavaScript cannot interleave another callback inside
 * this critical section, so every in-process mutation observes the preceding write rather than retaining a
 * stale snapshot across an asynchronous boundary.
 */
export function mutateRegionsStore (dataDir: string, mutate: (store: RegionsStore) => void): RegionsStore {
  const store = loadRegionsStore(dataDir)
  mutate(store)
  saveRegionsStore(dataDir, store)
  return store
}

/** Remove unavailable catalog entries from automatic position warming while preserving saved regions. */
export function reconcilePositionWarmSources (dataDir: string, sourceExists: (id: string) => boolean): string[] {
  const store = loadRegionsStore(dataDir)
  const unavailable = store.positionWarm.sources.filter((id) => !sourceExists(id))
  if (unavailable.length === 0) return []
  store.positionWarm = {
    ...store.positionWarm,
    sources: store.positionWarm.sources.filter(sourceExists)
  }
  saveRegionsStore(dataDir, store)
  return unavailable
}

/** Append a region to the persisted store and write it back. */
export function addRegion (dataDir: string, region: SavedRegion): void {
  mutateRegionsStore(dataDir, (store) => {
    if (store.regions.length >= MAX_SAVED_REGIONS) throw new RangeError(`saved region limit is ${MAX_SAVED_REGIONS}`)
    store.regions.push(region)
  })
}

/** Patch a region in place by id and write the store back; a no-op when the id is absent. */
export function updateRegion (dataDir: string, id: string, patch: Partial<SavedRegion>): void {
  mutateRegionsStore(dataDir, (store) => {
    const idx = store.regions.findIndex((r) => r.id === id)
    if (idx >= 0) store.regions[idx] = { ...store.regions[idx]!, ...patch }
  })
}

/** Drop a region by id from the persisted store and write it back. */
export function removeRegion (dataDir: string, id: string): void {
  mutateRegionsStore(dataDir, (store) => {
    store.regions = store.regions.filter((r) => r.id !== id)
  })
}

/** The persisted regions list. */
export function listRegions (dataDir: string): SavedRegion[] {
  return loadRegionsStore(dataDir).regions
}
