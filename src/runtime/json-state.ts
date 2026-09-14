/** A small sync JSON state helper: read a JSON file with a typed fallback, or write one (creating its
 * parent directory). Shared by the regions store and the PMTiles per-chart override store so the
 * persist-a-small-state-file idiom lives in one place rather than as a sync copy and an async copy. Sync
 * is appropriate for a single-writer state file the plugin owns. */

import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface ReadJsonStateOptions<T> {
  /** Validate the parsed root before it is trusted as T. */
  validate?: (value: unknown) => value is T
  /** Preserve invalid plugin-owned state beside the original before returning the fallback. */
  backupCorrupt?: boolean
}

function errorCode (error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

export interface PreserveInvalidJsonStateOptions {
  /**
   * Copy the file aside instead of moving it, leaving the original in place. Use this when a
   * normalized replacement is written afterwards: moving first means a failed write (ENOSPC, EDQUOT)
   * leaves no file under the expected name at all, and the next load reads the fallback and reports
   * nothing, which silently discards state the caller could still have recovered.
   */
  keepOriginal?: boolean
}

export function preserveInvalidJsonState (path: string, options: PreserveInvalidJsonStateOptions = {}): void {
  const backup = `${path}.corrupt-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    if (options.keepOriginal === true) copyFileSync(path, backup, constants.COPYFILE_EXCL)
    else renameSync(path, backup)
  } catch (error) {
    throw new Error(`cannot preserve invalid JSON state at ${path}`, { cause: error })
  }
}

/** How long a `.tmp-` sibling must be untouched before it is treated as abandoned. */
const STALE_TEMPORARY_MS = 10 * 60_000

/**
 * Remove `<path>.tmp-*` siblings left by a process killed between openSync and renameSync. The state
 * files here have a single writer, and no write survives the age threshold, so an older temporary
 * cannot belong to a live writer. Best effort throughout: a sweep failure must never fail a write.
 */
export function sweepStaleJsonStateTemporaries (path: string, maxAgeMs: number = STALE_TEMPORARY_MS): void {
  const parent = dirname(path)
  const prefix = `${basename(path)}.tmp-`
  const cutoff = Date.now() - maxAgeMs
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const candidate = join(parent, entry)
    try {
      if (statSync(candidate).mtimeMs > cutoff) continue
      unlinkSync(candidate)
    } catch {
      // A concurrent writer, a permission problem, or a racing sweep. Leave it for the next pass.
    }
  }
}

/**
 * The sidecar name a durable write stages its next document under.
 *
 * The prefix is exactly what `sweepStaleJsonStateTemporaries` matches on, so every writer takes its
 * name from here. Assembling one independently is how a module ends up leaving debris the reaper
 * beside it cannot recognize, with no test or type to catch it.
 */
export function jsonStateTemporaryPath (path: string): string {
  return `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`
}

/**
 * State files this process has already swept.
 *
 * The temporaries being reaped can only be left behind by a process that died between openSync and
 * renameSync, so a sweep after the first one in this process is guaranteed to find nothing. Without
 * this, every region add, delete, and retention change from the panel would list the whole Signal K
 * data directory synchronously, and that directory grows over a vessel's life.
 */
const sweptStatePaths = new Set<string>()

/**
 * Read and validate the JSON at `path`.
 *
 * A missing file returns `fallback`. Other read failures remain visible to callers. Invalid JSON or an
 * invalid root is moved aside before the fallback is returned, preventing the next successful mutation
 * from silently destroying the only copy of the bad state. Set `backupCorrupt` false only for state owned
 * by another plugin, where Chart Locker must never rename the file.
 */
export function readJsonState<T> (path: string, fallback: T, options: ReadJsonStateOptions<T> = {}): T {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return fallback
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (options.backupCorrupt !== false) preserveInvalidJsonState(path)
    return fallback
  }

  if (options.validate !== undefined && !options.validate(parsed)) {
    if (options.backupCorrupt !== false) preserveInvalidJsonState(path)
    return fallback
  }
  return parsed as T
}

/**
 * Durably replace `path` with pretty-printed JSON.
 *
 * The temporary file is flushed before rename, so a power loss can leave either the previous complete
 * document or the new complete document, never a truncated state file. The directory flush is best effort
 * because some supported platforms do not permit opening directories as file descriptors.
 */
export function writeJsonState (path: string, value: unknown): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  if (!sweptStatePaths.has(path)) {
    sweptStatePaths.add(path)
    sweepStaleJsonStateTemporaries(path)
  }
  const temporary = jsonStateTemporaryPath(path)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    try {
      const directoryFd = openSync(parent, 'r')
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
    } catch {
      // Directory fsync is unavailable on some platforms. The atomic rename still prevents truncation.
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}
