/** Watch a charts directory and keep the registry in step with the .pmtiles files in it, without a
 * plugin restart. Each file is realpath-resolved and confirmed contained under the directory before
 * it is decoded, so a symlink or a path that escapes the directory is rejected. */

import { type FSWatcher, watch } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { nameToId } from './chart-id.js'
import { type ChartRegistry, DEFAULT_SCALE } from './chart-registry.js'
import { type DecodeResult, decodePmtilesArchive, type DecodedPmtiles } from './pmtiles-metadata.js'

export interface ChartNamer {
  (fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number }
}

export function defaultNamer (fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number } {
  return { name: decoded.name ?? fileName.replace(/\.pmtiles$/i, ''), description: '', scale: DEFAULT_SCALE }
}

export interface DiscoveryDeps {
  chartsDir: string
  registry: ChartRegistry
  namer?: ChartNamer
  decode?: (filePath: string) => Promise<DecodeResult>
  debounceMs?: number
  onError?: (message: string) => void
}

const PMTILES_RE = /\.pmtiles$/i

async function containedRealPath (chartsDir: string, fileName: string): Promise<string | undefined> {
  try {
    const dirReal = await realpath(chartsDir)
    const fileReal = await realpath(join(chartsDir, fileName))
    return fileReal.startsWith(dirReal + sep) ? fileReal : undefined
  } catch {
    return undefined
  }
}

export async function rescanCharts (deps: DiscoveryDeps): Promise<void> {
  const decode = deps.decode ?? decodePmtilesArchive
  const namer = deps.namer ?? defaultNamer
  let entries: string[]
  try {
    entries = (await readdir(deps.chartsDir, { withFileTypes: true }))
      .filter((entry) => PMTILES_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    // A missing directory yields an empty set: the registry is cleared of stale records below.
    entries = []
  }

  const seen = new Set<string>()
  for (const fileName of entries) {
    const filePath = await containedRealPath(deps.chartsDir, fileName)
    if (!filePath) continue
    const result = await decode(filePath)
    if (!result.ok) {
      deps.registry.setError(fileName, result.error)
      deps.onError?.(`${fileName}: ${result.error}`)
      continue
    }
    deps.registry.clearError(fileName)
    const naming = namer(fileName, result.decoded)
    seen.add(nameToId(fileName))
    deps.registry.set({
      identifier: nameToId(fileName),
      fileName,
      filePath,
      name: naming.name,
      description: naming.description,
      type: 'tilelayer',
      scale: naming.scale,
      decoded: result.decoded
    })
  }

  for (const record of deps.registry.records()) {
    if (!seen.has(record.identifier)) deps.registry.delete(record.identifier)
  }
}

export interface DiscoveryHandle {
  stop: () => void
}

export async function startDiscovery (deps: DiscoveryDeps): Promise<DiscoveryHandle> {
  await rescanCharts(deps)
  const debounceMs = deps.debounceMs ?? 300
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(deps.chartsDir, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { rescanCharts(deps).catch(() => {}) }, debounceMs)
    })
  } catch (err) {
    deps.onError?.(`cannot watch ${deps.chartsDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    stop () {
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  }
}
