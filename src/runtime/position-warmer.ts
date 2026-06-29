/** The stateful position-warm loop: on each navigation.position fix it decides (via shouldWarm) whether to
 * warm a small radius around the vessel, throttles, and backs off when a warm returns all-errors (an
 * offline passage), so it does not fire roughly 16 fetches each blocking on the egress timeout every
 * interval. The container being healthy only means the container is up, not that the internet is up. */

import type { Position } from '../shared/types.js'
import type { PrewarmConfig } from './prewarm-store.js'
import type { WarmResult } from './tilecache-client.js'
import { shouldWarm, bboxAround, type WarmTrigger } from './position-warm.js'

export interface PositionWarmer {
  onPosition (pos: Position): void
}

interface Deps {
  getConfig: () => PrewarmConfig
  warm: (bbox: [number, number, number, number], sources: string[], minzoom: number, maxzoom: number) => Promise<WarmResult | null>
  now?: () => number
  backoffSecs?: number
}

/** A small zoom window around the configured base, capped to keep the warm at about 16 tiles. */
const ZOOM_SPREAD = 1
const DEFAULT_BACKOFF_SECS = 600

export function createPositionWarmer (deps: Deps): PositionWarmer {
  const now = deps.now ?? Date.now
  const backoffSecs = deps.backoffSecs ?? DEFAULT_BACKOFF_SECS
  const trigger: WarmTrigger = { lastPos: null, lastWarmMs: 0, backoffUntilMs: 0 }
  let inFlight = false

  return {
    onPosition (pos: Position): void {
      if (inFlight) return
      const config = deps.getConfig()
      const settings = config.positionWarm
      const nowMs = now()
      if (!shouldWarm(pos, config.bbox, settings, trigger, nowMs)) return
      const bbox = bboxAround(pos, settings.radiusMeters)
      const minzoom = Math.max(0, settings.baseZoom - ZOOM_SPREAD)
      const maxzoom = settings.baseZoom + ZOOM_SPREAD
      inFlight = true
      trigger.lastPos = pos
      trigger.lastWarmMs = nowMs
      // Single async IIFE so the backoff update and the inFlight reset land in one microtask
      // continuation, which flushes before the test's `await Promise.resolve()` resumes.
      // The inner try/catch handles every error; the outer .catch satisfies no-floating-promises.
      ;(async () => {
        try {
          const result = await deps.warm(bbox, settings.sources, minzoom, maxzoom)
          // All-errors (and a non-zero attempt) means offline: back off so we do not hammer the egress timeout.
          if (result !== null && result.total > 0 && result.errors >= result.total) {
            trigger.backoffUntilMs = now() + backoffSecs * 1000
          } else if (result === null) {
            trigger.backoffUntilMs = now() + backoffSecs * 1000
          }
        } catch {
          trigger.backoffUntilMs = now() + backoffSecs * 1000
        } finally {
          inFlight = false
        }
      })().catch(() => {})
    }
  }
}
