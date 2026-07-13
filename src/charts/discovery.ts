/** Watch a charts directory and keep the registry in step with the .pmtiles files in it, without a
 * plugin restart. Each file is realpath-resolved and confirmed contained under the directory before
 * it is decoded, so a symlink or a path that escapes the directory is rejected. */

import { type FSWatcher, watch } from 'node:fs'
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { nameToId } from './chart-id.js'
import { ChartRegistry, DEFAULT_SCALE } from './chart-registry.js'
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

async function containedRealPath (dirReal: string, fileName: string, chartsDir: string): Promise<string | undefined> {
  try {
    const fileReal = await realpath(join(chartsDir, fileName))
    // Contain the resolved file to the charts directory. Append the separator only when the directory
    // does not already end with one, so a root directory (dirReal is the separator itself) still matches
    // its children instead of demanding a doubled separator.
    const prefix = dirReal.endsWith(sep) ? dirReal : dirReal + sep
    return fileReal.startsWith(prefix) ? fileReal : undefined
  } catch {
    return undefined
  }
}

async function performRescanCharts (deps: DiscoveryDeps): Promise<void> {
  const decode = deps.decode ?? decodePmtilesArchive
  const namer = deps.namer ?? defaultNamer
  let dirReal: string | undefined
  try {
    dirReal = await realpath(deps.chartsDir)
  } catch {
    dirReal = undefined
  }

  let entries: string[]
  try {
    entries = (await readdir(deps.chartsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .filter((entry) => PMTILES_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    // A missing directory yields an empty set: the registry is cleared of stale records below.
    entries = []
  }

  const seen = new Set<string>()
  const activeErrors = new Set<string>()
  for (const fileName of entries) {
    if (!dirReal) continue
    const filePath = await containedRealPath(dirReal, fileName, deps.chartsDir)
    if (!filePath) continue
    const id = nameToId(fileName)
    // File identity (mtime plus size): when it matches the stored record, reuse the cached decode and
    // only re-run the namer, so a rescan (a watch event, or an override edit that renames without
    // touching the file) does not re-parse every unchanged archive.
    let mtimeMs: number | undefined
    let mtimeNs: bigint | undefined
    let device: bigint | undefined
    let inode: bigint | undefined
    let bytes: number | undefined
    try {
      const st = await stat(filePath, { bigint: true })
      mtimeMs = Number(st.mtimeMs)
      mtimeNs = st.mtimeNs
      device = st.dev
      inode = st.ino
      bytes = Number(st.size)
    } catch { /* fall through to a fresh decode */ }

    const existing = deps.registry.record(id)
    let decoded: DecodedPmtiles
    if (existing !== undefined && mtimeNs !== undefined && existing.mtimeNs === mtimeNs &&
        existing.device === device && existing.inode === inode && existing.bytes === bytes) {
      decoded = existing.decoded
    } else {
      const result = await decode(filePath)
      if (!result.ok) {
        deps.registry.setError(fileName, result.error)
        activeErrors.add(fileName)
        deps.onError?.(`${fileName}: ${result.error}`)
        continue
      }
      decoded = result.decoded
    }
    deps.registry.clearError(fileName)
    const naming = namer(fileName, decoded)
    seen.add(id)
    deps.registry.set({
      identifier: id,
      fileName,
      filePath,
      name: naming.name,
      description: naming.description,
      type: 'tilelayer',
      scale: naming.scale,
      decoded,
      mtimeMs,
      mtimeNs,
      device,
      inode,
      bytes
    })
  }

  for (const record of deps.registry.records()) {
    if (!seen.has(record.identifier)) deps.registry.delete(record.identifier)
  }
  deps.registry.retainErrors(activeErrors)
  deps.registry.markScanned()
}

// One queue per registry. Watch events, manual rescans, and override re-application all converge here,
// so a slow archive decode cannot overlap another scan and publish an older snapshot last.
const scanQueues = new WeakMap<ChartRegistry, Promise<void>>()

export function rescanCharts (deps: DiscoveryDeps): Promise<void> {
  const previous = scanQueues.get(deps.registry) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => performRescanCharts(deps))
  scanQueues.set(deps.registry, next)
  return next.finally(() => {
    if (scanQueues.get(deps.registry) === next) scanQueues.delete(deps.registry)
  })
}

export interface DiscoveryHandle {
  stop: () => void
}

export async function startDiscovery (deps: DiscoveryDeps): Promise<DiscoveryHandle> {
  try {
    await mkdir(deps.chartsDir, { recursive: true })
  } catch (error) {
    deps.onError?.(`cannot create ${deps.chartsDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  await rescanCharts(deps)
  const debounceMs = deps.debounceMs ?? 300
  let timer: NodeJS.Timeout | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  let stopped = false
  const scheduleRetry = (): void => {
    if (stopped || retryTimer !== undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      installWatcher()
    }, 5000)
    retryTimer.unref()
  }
  const installWatcher = (): void => {
    if (stopped || watcher !== undefined) return
    try {
      watcher = watch(deps.chartsDir, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          rescanCharts(deps).catch((error: unknown) => {
            deps.onError?.(`chart rescan failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }, debounceMs)
      })
      watcher.unref()
      watcher.on('error', (error) => {
        deps.onError?.(`chart directory watch failed: ${error.message}`)
        watcher?.close()
        watcher = undefined
        scheduleRetry()
      })
    } catch (err) {
      deps.onError?.(`cannot watch ${deps.chartsDir}: ${err instanceof Error ? err.message : String(err)}`)
      scheduleRetry()
    }
  }
  installWatcher()
  return {
    stop () {
      stopped = true
      if (timer) clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
      watcher?.close()
    }
  }
}
