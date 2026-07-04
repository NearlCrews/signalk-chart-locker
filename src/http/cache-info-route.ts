/** The admin-gated cache-info route. It reports the free space on the Signal K data directory and the
 *  recommended cache cap, so the browser configuration panel can seed its default and warn when the
 *  cap exceeds free space. The panel cannot stat the server filesystem itself. Mounted only behind the
 *  admin gate, so an ungatable server leaves it unmounted (fail closed). */

import type { ServerAPI } from '@signalk/server-api'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
import { CACHE_CAP_STATIC_DEFAULT_GIB, deriveDefaultCapGiB } from '../shared/cache-cap.js'
import { readFreeGiB, type StatfsResult } from '../runtime/free-space.js'

export interface CacheInfoRequest { params: Record<string, string> }

export interface CacheInfoResponse {
  status (code: number): CacheInfoResponse
  json (value: unknown): void
}

export interface CacheInfoRouter {
  get (path: string, handler: (req: CacheInfoRequest, res: CacheInfoResponse) => void): void
}

interface Deps {
  dataDir?: string
  statfs?: (path: string) => StatfsResult
}

/** Mount the cache-info route behind the admin gate. Returns whether it was mounted. */
export function registerCacheInfoRoute (router: CacheInfoRouter, app: ServerAPI, deps: Deps = {}): boolean {
  if (!ensureApiAdminGate(app)) return false
  const dataDir = deps.dataDir ?? app.getDataDirPath()

  router.get('/api/cache-info', (_req, res) => {
    try {
      const freeGiB = readFreeGiB(dataDir, deps.statfs)
      res.status(200).json({ freeGiB, recommendedCapGiB: deriveDefaultCapGiB(freeGiB) })
    } catch {
      // Detection failed (early call or a platform without statfs): report no free space and the
      // static default so the panel still has a usable recommendation and shows no free-space line.
      res.status(200).json({ freeGiB: null, recommendedCapGiB: CACHE_CAP_STATIC_DEFAULT_GIB })
    }
  })
  return true
}
