/** A small sync JSON state helper: read a JSON file with a typed fallback, or write one (creating its
 * parent directory). Shared by the regions store and the PMTiles per-chart override store so the
 * persist-a-small-state-file idiom lives in one place rather than as a sync copy and an async copy. Sync
 * is appropriate for a single-writer state file the plugin owns. */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

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

export function preserveInvalidJsonState (path: string): void {
  const backup = `${path}.corrupt-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    renameSync(path, backup)
  } catch (error) {
    throw new Error(`cannot preserve invalid JSON state at ${path}`, { cause: error })
  }
}

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
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
