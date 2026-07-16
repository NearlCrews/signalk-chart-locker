/** Watch a charts directory and keep the registry in step with the .pmtiles files in it, without a
 * plugin restart. Each file is realpath-resolved and confirmed contained under the directory before
 * it is decoded, so a symlink or a path that escapes the directory is rejected. */

import { type FSWatcher, watch } from 'node:fs'
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nameToId } from './chart-id.js'
import { ChartRegistry, DEFAULT_SCALE, type ChartRecord } from './chart-registry.js'
import { type DecodeResult, decodePmtilesArchive, type DecodedPmtiles } from './pmtiles-metadata.js'
import { hasControlCharacter } from '../shared/text.js'

export interface ChartNamer {
  (fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number }
}

export function defaultNamer (fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number } {
  const fileStem = fileName.replace(/\.pmtiles$/i, '')
  const safeFileStem = hasControlCharacter(fileStem)
    ? Array.from(fileStem, (character) => hasControlCharacter(character) ? ' ' : character).join('').replace(/\s+/g, ' ').trim()
    : fileStem
  return { name: decoded.name ?? (safeFileStem || 'Unnamed chart'), description: '', scale: DEFAULT_SCALE }
}

export interface DiscoveryDeps {
  chartsDir: string
  registry: ChartRegistry
  namer?: ChartNamer
  decode?: (filePath: string) => Promise<DecodeResult>
  debounceMs?: number
  pollIntervalMs?: number
  onError?: (message: string) => void
  /** When present, the resolved charts root must remain inside this directory. */
  allowedRoot?: string
  /** Internal lifecycle guard used by a DiscoveryHandle. */
  shouldPublish?: () => boolean
  /** Internal test seam for the self-heal poll. */
  directoryIdentity?: (path: string) => Promise<string | undefined>
}

const PMTILES_RE = /\.pmtiles$/i
const MAX_DIAGNOSTIC_FILENAME_LENGTH = 160

function diagnosticFileName (fileName: string): string {
  const printable = Array.from(fileName, (character) => hasControlCharacter(character) ? '?' : character).join('')
  const bounded = printable.slice(0, MAX_DIAGNOSTIC_FILENAME_LENGTH)
  return bounded === '' ? '<invalid filename>' : bounded
}

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

async function rootIsAllowed (chartsDir: string, allowedRoot: string | undefined): Promise<boolean> {
  if (allowedRoot === undefined) return true
  try {
    const [chartsReal, allowedReal] = await Promise.all([realpath(chartsDir), realpath(allowedRoot)])
    const rel = relative(allowedReal, chartsReal)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  } catch {
    return false
  }
}

function isContainedRelativePath (rel: string): boolean {
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function hasNoSymlinkedComponents (allowedRoot: string, rel: string): Promise<boolean> {
  let current = resolve(allowedRoot)
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) return false
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') return true
      return false
    }
  }
  return true
}

async function chartsRootIsSafe (deps: Pick<DiscoveryDeps, 'chartsDir' | 'allowedRoot'>): Promise<boolean> {
  if (!(await rootIsAllowed(deps.chartsDir, deps.allowedRoot))) return false
  if (deps.allowedRoot === undefined) return true
  const rel = relative(resolve(deps.allowedRoot), resolve(deps.chartsDir))
  return isContainedRelativePath(rel) && await hasNoSymlinkedComponents(deps.allowedRoot, rel)
}

/** Validate existing components before recursive creation, then verify the created root again. */
async function prepareChartsDirectory (deps: DiscoveryDeps): Promise<boolean> {
  if (deps.allowedRoot === undefined) {
    try {
      await mkdir(deps.chartsDir, { recursive: true })
      return true
    } catch (error) {
      deps.onError?.(`cannot create ${deps.chartsDir}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  const rel = relative(resolve(deps.allowedRoot), resolve(deps.chartsDir))
  if (!isContainedRelativePath(rel) || !(await hasNoSymlinkedComponents(deps.allowedRoot, rel))) {
    deps.onError?.(`charts directory resolves outside ${deps.allowedRoot}`)
    return false
  }
  try {
    await mkdir(deps.chartsDir, { recursive: true })
  } catch (error) {
    deps.onError?.(`cannot create ${deps.chartsDir}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  return await chartsRootIsSafe(deps)
}

async function directoryIdentity (path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true })
    return info.isDirectory() ? `${info.dev}:${info.ino}` : undefined
  } catch {
    return undefined
  }
}

interface FileIdentity {
  mtimeMs: number
  mtimeNs: bigint
  device: bigint
  inode: bigint
  bytes: number
}

async function readFileIdentity (filePath: string): Promise<FileIdentity | undefined> {
  try {
    const info = await stat(filePath, { bigint: true })
    const bytes = Number(info.size)
    if (!info.isFile() || !Number.isSafeInteger(bytes) || bytes < 0) return undefined
    return {
      mtimeMs: Number(info.mtimeMs),
      mtimeNs: info.mtimeNs,
      device: info.dev,
      inode: info.ino,
      bytes
    }
  } catch {
    return undefined
  }
}

function sameIdentity (left: FileIdentity, right: FileIdentity): boolean {
  return left.mtimeNs === right.mtimeNs && left.device === right.device && left.inode === right.inode && left.bytes === right.bytes
}

async function performRescanCharts (deps: DiscoveryDeps): Promise<void> {
  const decode = deps.decode ?? decodePmtilesArchive
  const namer = deps.namer ?? defaultNamer
  if (!(await chartsRootIsSafe(deps))) {
    deps.onError?.(`charts directory resolves outside ${deps.allowedRoot ?? 'the allowed root'}`)
    if (deps.shouldPublish?.() !== false) deps.registry.replace([], [['<charts-directory>', 'charts directory escapes the Signal K configuration directory']])
    return
  }
  let dirReal: string | undefined
  try {
    dirReal = await realpath(deps.chartsDir)
  } catch {
    dirReal = undefined
  }

  let discoveredEntries: string[]
  try {
    discoveredEntries = (await readdir(deps.chartsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .filter((entry) => PMTILES_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    // A missing directory yields an empty set: the registry is cleared of stale records below.
    discoveredEntries = []
  }

  const records: ChartRecord[] = []
  const errors = new Map<string, string>()
  const entries: string[] = []
  for (const fileName of discoveredEntries) {
    if (!hasControlCharacter(fileName)) {
      entries.push(fileName)
      continue
    }
    const displayName = diagnosticFileName(fileName)
    const error = 'filename contains control characters'
    errors.set(displayName, error)
    deps.onError?.(`${displayName}: ${error}`)
  }
  const safeEntries: Array<{ fileName: string, filePath: string }> = []
  for (const fileName of entries) {
    const filePath = dirReal === undefined ? undefined : await containedRealPath(dirReal, fileName, deps.chartsDir)
    if (filePath === undefined) {
      const error = 'archive is broken or resolves outside the charts directory'
      errors.set(fileName, error)
      deps.onError?.(`${diagnosticFileName(fileName)}: ${error}`)
    } else {
      safeEntries.push({ fileName, filePath })
    }
  }
  const idCounts = new Map<string, number>()
  for (const { fileName } of safeEntries) {
    const id = nameToId(fileName)
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  for (const { fileName, filePath } of safeEntries) {
    const id = nameToId(fileName)
    if ((idCounts.get(id) ?? 0) > 1) {
      const error = `chart identifier collision: ${id}`
      errors.set(fileName, error)
      deps.onError?.(`${diagnosticFileName(fileName)}: ${error}`)
      continue
    }
    // File identity (mtime plus size): when it matches the stored record, reuse the cached decode and
    // only re-run the namer, so a rescan (a watch event, or an override edit that renames without
    // touching the file) does not re-parse every unchanged archive.
    const identity = await readFileIdentity(filePath)
    if (identity === undefined) {
      const error = 'cannot stat a regular archive with a safe file size'
      errors.set(fileName, error)
      deps.onError?.(`${diagnosticFileName(fileName)}: ${error}`)
      continue
    }

    const existing = deps.registry.record(id)
    let decoded: DecodedPmtiles
    if (existing !== undefined && existing.mtimeNs === identity.mtimeNs &&
        existing.device === identity.device && existing.inode === identity.inode && existing.bytes === identity.bytes) {
      decoded = existing.decoded
    } else {
      const result = await decode(filePath)
      if (!result.ok) {
        errors.set(fileName, result.error)
        deps.onError?.(`${diagnosticFileName(fileName)}: ${result.error}`)
        continue
      }
      decoded = result.decoded
      const afterDecode = await readFileIdentity(filePath)
      if (afterDecode === undefined || !sameIdentity(identity, afterDecode)) {
        const error = 'archive changed while it was being decoded'
        errors.set(fileName, error)
        deps.onError?.(`${diagnosticFileName(fileName)}: ${error}`)
        continue
      }
    }
    const naming = namer(fileName, decoded)
    records.push({
      identifier: id,
      fileName,
      filePath,
      name: naming.name,
      description: naming.description,
      type: 'tilelayer',
      scale: naming.scale,
      decoded,
      ...identity
    })
  }

  if (deps.shouldPublish?.() !== false) deps.registry.replace(records, errors)
}

interface ScanQueue {
  running: Promise<void> | null
  dirty: boolean
  deps: DiscoveryDeps
  completion: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

// One coalescing queue per registry. A storm can request one follow-up scan while a scan is active,
// but cannot build an unbounded list of redundant full-directory scans.
const scanQueues = new WeakMap<ChartRegistry, ScanQueue>()

export function rescanCharts (deps: DiscoveryDeps): Promise<void> {
  let queue = scanQueues.get(deps.registry)
  if (queue === undefined) {
    let resolveCompletion!: () => void
    let rejectCompletion!: (error: unknown) => void
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    queue = { running: null, dirty: false, deps, completion, resolve: resolveCompletion, reject: rejectCompletion }
    scanQueues.set(deps.registry, queue)
  }
  queue.deps = deps
  queue.dirty = true
  if (queue.running === null) {
    queue.running = (async () => {
      try {
        while (queue!.dirty) {
          queue!.dirty = false
          await performRescanCharts(queue!.deps)
        }
        queue!.resolve()
      } catch (error) {
        queue!.dirty = false
        queue!.reject(error)
      } finally {
        queue!.running = null
        scanQueues.delete(deps.registry)
      }
    })()
  }
  return queue.completion
}

export interface DiscoveryHandle {
  rescan: () => Promise<void>
  stop: () => Promise<void>
}

export async function startDiscovery (deps: DiscoveryDeps): Promise<DiscoveryHandle> {
  const rootAccepted = await prepareChartsDirectory(deps)
  let stopped = false
  const scopedDeps: DiscoveryDeps = { ...deps, shouldPublish: () => !stopped }
  await rescanCharts(scopedDeps)
  const debounceMs = deps.debounceMs ?? 300
  let timer: NodeJS.Timeout | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let pollInFlight: Promise<void> | null = null
  let watcher: FSWatcher | undefined
  let watchedIdentity: string | undefined
  const runRescan = (): void => {
    if (stopped) return
    rescanCharts(scopedDeps).catch((error: unknown) => {
      deps.onError?.(`chart rescan failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const installWatcher = (identity: string): void => {
    if (stopped || watcher !== undefined) return
    try {
      watcher = watch(deps.chartsDir, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          runRescan()
        }, debounceMs)
      })
      watchedIdentity = identity
      watcher.unref()
      watcher.on('error', (error) => {
        deps.onError?.(`chart directory watch failed: ${error.message}`)
        watcher?.close()
        watcher = undefined
        watchedIdentity = undefined
      })
    } catch (err) {
      deps.onError?.(`cannot watch ${deps.chartsDir}: ${err instanceof Error ? err.message : String(err)}`)
      watchedIdentity = undefined
    }
  }
  const poll = async (): Promise<void> => {
    if (stopped) return
    const identity = await (deps.directoryIdentity ?? directoryIdentity)(deps.chartsDir)
    if (stopped) return
    if (identity !== watchedIdentity) {
      watcher?.close()
      watcher = undefined
      watchedIdentity = undefined
      if (identity !== undefined && process.platform === 'linux' && await chartsRootIsSafe(deps) && !stopped) installWatcher(identity)
    }
    runRescan()
  }
  const requestPoll = (): void => {
    if (stopped || pollInFlight !== null) return
    const active = poll()
      .catch((error: unknown) => deps.onError?.(`chart self-heal poll failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (pollInFlight === active) pollInFlight = null
      })
    pollInFlight = active
  }
  // Linux uses native events for low latency, plus a slow identity poll so deleting and recreating the
  // directory cannot strand the watcher on the old inode. Other platforms use only the poll because
  // macOS events can be dropped, and Node 24's Windows watcher can assert during directory teardown.
  if (rootAccepted && process.platform === 'linux') {
    const identity = await (deps.directoryIdentity ?? directoryIdentity)(deps.chartsDir)
    if (identity !== undefined) installWatcher(identity)
  }
  if (rootAccepted) {
    pollTimer = setInterval(requestPoll, deps.pollIntervalMs ?? 5000)
    pollTimer.unref()
  }
  return {
    rescan: () => stopped ? Promise.resolve() : rescanCharts(scopedDeps),
    async stop () {
      stopped = true
      if (timer) clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
      watcher?.close()
      watchedIdentity = undefined
      const activePoll = pollInFlight
      if (activePoll !== null) await activePoll
      const running = scanQueues.get(deps.registry)?.running
      if (running !== null && running !== undefined) await running
    }
  }
}
