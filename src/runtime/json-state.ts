/** A small sync JSON state helper: read a JSON file with a typed fallback, or write one (creating its
 * parent directory). Shared by the prewarm store and the PMTiles per-chart override store so the
 * persist-a-small-state-file idiom lives in one place rather than as a sync copy and an async copy. Sync
 * is appropriate for a single-writer state file the plugin owns. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Read and parse the JSON at `path`, returning `fallback` on a missing or corrupt file. */
export function readJsonState<T> (path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Write `value` as pretty JSON to `path`, creating the parent directory if it is absent. */
export function writeJsonState (path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}
