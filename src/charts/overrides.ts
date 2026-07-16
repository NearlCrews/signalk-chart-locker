/** Per-chart overrides of the name, description, and scale, persisted server-side in a JSON file
 * under the plugin data directory through the shared sync json-state helper (the same persistence seam
 * as the regions store). Keyed by chart identifier. The namer applies an override over the decoded
 * name and the defaults. */

import { type ChartNamer, defaultNamer } from './discovery.js'
import { nameToId } from './chart-id.js'
import type { DecodedPmtiles } from './pmtiles-metadata.js'
import { readJsonState, writeJsonState } from '../runtime/json-state.js'
import { hasControlCharacter, normalizePrintableText } from '../shared/text.js'

export interface ChartOverride {
  name?: string
  description?: string
  scale?: number
}

const MAX_OVERRIDES = 1024
const MAX_OVERRIDE_ID_LENGTH = 512
const MAX_OVERRIDE_NAME_LENGTH = 120
const MAX_OVERRIDE_DESCRIPTION_LENGTH = 1000
const MAX_OVERRIDE_SCALE = Number.MAX_SAFE_INTEGER
const OVERRIDE_FIELDS = new Set(['name', 'description', 'scale'])

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Apply the same bounded semantics to API patches and manually edited durable state. */
export function readChartOverride (value: unknown): ChartOverride | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => !OVERRIDE_FIELDS.has(key))) return undefined
  const normalized: ChartOverride = {}
  if ('name' in value) {
    const name = normalizePrintableText(value.name, MAX_OVERRIDE_NAME_LENGTH)
    if (name === undefined) return undefined
    normalized.name = name
  }
  if ('description' in value) {
    const description = normalizePrintableText(value.description, MAX_OVERRIDE_DESCRIPTION_LENGTH, true)
    if (description === undefined) return undefined
    normalized.description = description
  }
  if ('scale' in value) {
    if (typeof value.scale !== 'number' || !Number.isFinite(value.scale) || value.scale <= 0 || value.scale > MAX_OVERRIDE_SCALE) return undefined
    normalized.scale = value.scale
  }
  return normalized
}

function validOverrideId (id: string): boolean {
  return id.length > 0 && id.length <= MAX_OVERRIDE_ID_LENGTH && !hasControlCharacter(id)
}

function isOverrideMap (value: unknown): value is Record<string, ChartOverride> {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= MAX_OVERRIDES && entries.every(([id, entry]) => validOverrideId(id) && readChartOverride(entry) !== undefined)
}

function normalizeOverrideMap (value: Record<string, ChartOverride>): Record<string, ChartOverride> {
  return Object.fromEntries(Object.entries(value).map(([id, entry]) => [id, readChartOverride(entry)!]))
}

export class OverrideStore {
  readonly #filePath: string
  #map: Record<string, ChartOverride> = {}

  constructor (filePath: string) {
    this.#filePath = filePath
  }

  /** Load the persisted overrides from disk. Must be called once before get or namer: until it runs the
   * in-memory map is empty, so get returns undefined and namer applies only the decoded defaults. */
  load (): void {
    this.#map = normalizeOverrideMap(readJsonState<Record<string, ChartOverride>>(this.#filePath, {}, { validate: isOverrideMap }))
  }

  get (id: string): ChartOverride | undefined {
    return this.#map[id]
  }

  /** Merge the given fields into the stored override for this id, so a caller that sets only one field
   * (for example the scale) does not wipe the previously stored name and description. This mirrors the
   * patch-merge the position-warm settings use, rather than a full replace. */
  set (id: string, override: ChartOverride): void {
    if (!validOverrideId(id)) throw new RangeError('invalid chart override identifier')
    const merged = readChartOverride({ ...this.#map[id], ...override })
    if (merged === undefined) throw new RangeError('invalid chart override')
    const next = { ...this.#map, [id]: merged }
    if (Object.keys(next).length > MAX_OVERRIDES) throw new RangeError(`chart override limit is ${MAX_OVERRIDES}`)
    writeJsonState(this.#filePath, next)
    this.#map = next
  }

  namer (): ChartNamer {
    return (fileName: string, decoded: DecodedPmtiles) => {
      const base = defaultNamer(fileName, decoded)
      const override = this.#map[nameToId(fileName)]
      return {
        name: override?.name ?? base.name,
        description: override?.description ?? base.description,
        scale: override?.scale ?? base.scale
      }
    }
  }
}
