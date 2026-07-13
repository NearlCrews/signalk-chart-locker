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

/** Read and parse the JSON at `path`, returning `fallback` on a missing or corrupt file. */
export function readJsonState<T> (path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
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
