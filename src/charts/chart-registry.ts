/** Holds the discovered chart set and exposes it to the Signal K resources read path. The provider
 * methods and the v1 routes read the live registry, so discovery mutates the map and the registration
 * happens once. Signal K exposes no unregisterResourceProvider and Express no route deregistration,
 * so teardown clears the map: the provider then serves an empty set. */

import type { ResourceProvider } from '@signalk/server-api'
import type { LngLatBbox } from 'signalk-chart-sources'
import type { DecodedPmtiles } from './pmtiles-metadata.js'
import { PLUGIN_MOUNT_PATH } from '../shared/plugin-id.js'

const SERVE_BASE = `${PLUGIN_MOUNT_PATH}/pmtiles`
export const DEFAULT_SCALE = 250000
const V1_CHARTS = '/signalk/v1/api/resources/charts'

export function serveUrl (fileName: string): string {
  return `${SERVE_BASE}/${encodeURIComponent(fileName)}`
}

export interface ChartRecord {
  identifier: string
  fileName: string
  filePath: string
  name: string
  description: string
  type: 'tilelayer'
  scale: number
  decoded: DecodedPmtiles
  /** File identity captured at decode time, so a rescan can skip re-decoding an unchanged file. */
  mtimeMs?: number
  mtimeNs?: bigint
  device?: bigint
  inode?: bigint
  bytes?: number
}

export interface ChartResource {
  identifier: string
  name: string
  description: string
  type: 'tilelayer'
  scale: number
  bounds?: LngLatBbox
  minzoom: number
  maxzoom: number
  format: string
  url: string
  tilemapUrl: string
  layers: string[]
}

export function chartResource (record: ChartRecord): ChartResource {
  const url = serveUrl(record.fileName)
  return {
    identifier: record.identifier,
    name: record.name,
    description: record.description,
    type: record.type,
    scale: record.scale,
    ...(record.decoded.bounds ? { bounds: record.decoded.bounds } : {}),
    minzoom: record.decoded.minzoom,
    maxzoom: record.decoded.maxzoom,
    format: record.decoded.format,
    url,
    tilemapUrl: url,
    layers: record.decoded.vectorLayers
  }
}

export class ChartRegistry {
  readonly #records = new Map<string, ChartRecord>()
  readonly #errors = new Map<string, string>()
  #lastScanAt: number | null = null

  set (record: ChartRecord): void {
    this.#records.set(record.identifier, record)
  }

  /** Publish one complete discovery snapshot without exposing a partially updated scan. */
  replace (records: Iterable<ChartRecord>, errors: Iterable<readonly [string, string]>, at = Date.now()): void {
    this.#records.clear()
    for (const record of records) this.#records.set(record.identifier, record)
    this.#errors.clear()
    for (const [fileName, error] of errors) this.#errors.set(fileName, error)
    this.#lastScanAt = at
  }

  delete (id: string): void {
    this.#records.delete(id)
  }

  clear (): void {
    this.#records.clear()
    this.#errors.clear()
    this.#lastScanAt = null
  }

  has (id: string): boolean {
    return this.#records.has(id)
  }

  filePathFor (id: string): string | undefined {
    return this.#records.get(id)?.filePath
  }

  /** The raw stored record (with its decoded metadata and file identity), for the rescan skip check. */
  record (id: string): ChartRecord | undefined {
    return this.#records.get(id)
  }

  records (): ChartRecord[] {
    return [...this.#records.values()]
  }

  list (): ChartResource[] {
    return this.records().map(chartResource)
  }

  get (id: string): ChartResource | undefined {
    const record = this.#records.get(id)
    return record ? chartResource(record) : undefined
  }

  setError (fileName: string, error: string): void {
    this.#errors.set(fileName, error)
  }

  clearError (fileName: string): void {
    this.#errors.delete(fileName)
  }

  errors (): Array<{ fileName: string, error: string }> {
    return [...this.#errors.entries()].map(([fileName, error]) => ({ fileName, error }))
  }

  retainErrors (fileNames: Set<string>): void {
    for (const fileName of this.#errors.keys()) {
      if (!fileNames.has(fileName)) this.#errors.delete(fileName)
    }
  }

  markScanned (at = Date.now()): void {
    this.#lastScanAt = at
  }

  discoveryStatus (): { valid: number, invalid: number, lastScanAt: number | null } {
    return { valid: this.#records.size, invalid: this.#errors.size, lastScanAt: this.#lastScanAt }
  }
}

interface V1Res {
  json (body: unknown): void
  status (code: number): V1Res
  send (body: string): void
}

export interface ChartRouteApp {
  get (path: string, handler: (req: { params: Record<string, string> }, res: V1Res) => void): void
  registerResourceProvider (provider: ResourceProvider): void
}

// Register the v2 provider and the v1 routes once per app, so an enable, disable, then re-enable
// cycle does not throw a duplicate-provider error. A mutable holder lets a recreated plugin factory
// rebind the permanent provider and routes to its new live registry.
const registeredApps = new WeakMap<object, { registry: ChartRegistry }>()

export function registerChartProvider (app: ChartRouteApp, registry: ChartRegistry): void {
  const existing = registeredApps.get(app)
  if (existing !== undefined) {
    existing.registry = registry
    return
  }
  const holder = { registry }

  app.registerResourceProvider({
    type: 'charts',
    methods: {
      listResources: () => {
        // No server-side filtering; the local registry always returns all charts
        const out: Record<string, ChartResource> = {}
        for (const resource of holder.registry.list()) out[resource.identifier] = resource
        return Promise.resolve(out)
      },
      getResource: (id: string) => {
        const resource = holder.registry.get(id)
        return resource ? Promise.resolve(resource) : Promise.reject(new Error(`Chart not found: ${id}`))
      },
      setResource: (_id: string, _value: unknown) => Promise.reject(new Error(`Not implemented: cannot set ${_id}`)),
      deleteResource: (_id: string) => Promise.reject(new Error(`Not implemented: cannot delete ${_id}`))
    }
  })
  // Publish the holder only after the server accepts the provider. A thrown registration remains
  // retryable instead of poisoning this app in the deduplication map.
  registeredApps.set(app, holder)

  app.get(`${V1_CHARTS}/:identifier`, (req, res) => {
    const resource = holder.registry.get(req.params.identifier)
    if (resource) res.json(resource)
    else res.status(404).send('Not found')
  })
  app.get(V1_CHARTS, (_req, res) => {
    const out: Record<string, ChartResource> = {}
    for (const resource of holder.registry.list()) out[resource.identifier] = resource
    res.json(out)
  })
}
