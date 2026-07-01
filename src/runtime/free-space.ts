/**
 * Read the free space on a filesystem, in whole GiB. Hoisted so the schema's default-cap derivation
 * and the cache-info route share one definition rather than each inlining the statfs arithmetic. The
 * statfs call is injectable so tests can drive it without a real filesystem. This is a node module
 * (it touches node:fs); the browser-safe bounds and math live in ../shared/cache-cap.js.
 */

import { statfsSync } from 'node:fs'

/** The two statfs fields the free-space computation needs. */
export interface StatfsResult {
  bsize: number
  bavail: number
}

/**
 * Free space on the filesystem holding `dataDir`, in whole GiB, floored. Throws if the statfs call
 * throws (an early call before the path exists, or a platform without statfs); callers wrap it and
 * fall back to the static default.
 */
export function readFreeGiB (dataDir: string, statfs: (path: string) => StatfsResult = statfsSync): number {
  const { bsize, bavail } = statfs(dataDir)
  return Math.floor((bsize * bavail) / (1024 ** 3))
}
