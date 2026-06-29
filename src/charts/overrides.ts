/** Per-chart overrides of the name, description, and scale, persisted server-side in a JSON file
 * under the plugin data directory through the shared sync json-state helper (the same persistence seam
 * as the prewarm store). Keyed by chart identifier. The namer applies an override over the decoded
 * name and the defaults. */

import { type ChartNamer, defaultNamer } from './discovery.js'
import type { DecodedPmtiles } from './pmtiles-metadata.js'
import { readJsonState, writeJsonState } from '../runtime/json-state.js'

export interface ChartOverride {
  name?: string
  description?: string
  scale?: number
}

export class OverrideStore {
  readonly #filePath: string
  #map: Record<string, ChartOverride> = {}

  constructor (filePath: string) {
    this.#filePath = filePath
  }

  load (): void {
    this.#map = readJsonState<Record<string, ChartOverride>>(this.#filePath, {})
  }

  get (id: string): ChartOverride | undefined {
    return this.#map[id]
  }

  set (id: string, override: ChartOverride): void {
    this.#map[id] = override
    writeJsonState(this.#filePath, this.#map)
  }

  namer (): ChartNamer {
    return (fileName: string, decoded: DecodedPmtiles) => {
      const base = defaultNamer(fileName, decoded)
      const override = this.#map[fileName.replace('.pmtiles', '-pmtiles')]
      return {
        name: override?.name ?? base.name,
        description: override?.description ?? base.description,
        scale: override?.scale ?? base.scale
      }
    }
  }
}
