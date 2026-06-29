/** Holds the discovered chart set and exposes it to the Signal K resources read path. The provider
 * methods and the v1 routes read the live registry, so discovery mutates the map and the registration
 * happens once. Signal K exposes no unregisterResourceProvider and Express no route deregistration,
 * so teardown clears the map: the provider then serves an empty set. */

import type { ResourceProvider } from '@signalk/server-api'
import type { DecodedPmtiles } from './pmtiles-metadata.js'

export const SERVE_BASE = '/plugins/signalk-binnacle-companion/pmtiles'
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
}

export interface ChartResource {
  identifier: string
  name: string
  description: string
  type: 'tilelayer'
  scale: number
  bounds?: [number, number, number, number]
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

  set (record: ChartRecord): void {
    this.#records.set(record.identifier, record)
  }

  delete (id: string): void {
    this.#records.delete(id)
  }

  clear (): void {
    this.#records.clear()
    this.#errors.clear()
  }

  has (id: string): boolean {
    return this.#records.has(id)
  }

  filePathFor (id: string): string | undefined {
    return this.#records.get(id)?.filePath
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
// cycle does not throw a duplicate-provider error. The methods close over the live registry.
const registeredApps = new WeakSet<object>()

export function registerChartProvider (app: ChartRouteApp, registry: ChartRegistry): void {
  if (registeredApps.has(app)) return
  registeredApps.add(app)

  app.registerResourceProvider({
    type: 'charts',
    methods: {
      listResources: () => {
        const out: Record<string, ChartResource> = {}
        for (const resource of registry.list()) out[resource.identifier] = resource
        return Promise.resolve(out)
      },
      getResource: (id: string) => {
        const resource = registry.get(id)
        return resource ? Promise.resolve(resource) : Promise.reject(new Error(`Chart not found: ${id}`))
      },
      setResource: (id: string) => Promise.reject(new Error(`Not implemented: cannot set ${id}`)),
      deleteResource: (id: string) => Promise.reject(new Error(`Not implemented: cannot delete ${id}`))
    }
  })

  app.get(`${V1_CHARTS}/:identifier`, (req, res) => {
    const resource = registry.get(req.params.identifier)
    if (resource) res.json(resource)
    else res.status(404).send('Not found')
  })
  app.get(V1_CHARTS, (_req, res) => {
    const out: Record<string, ChartResource> = {}
    for (const resource of registry.list()) out[resource.identifier] = resource
    res.json(out)
  })
}
