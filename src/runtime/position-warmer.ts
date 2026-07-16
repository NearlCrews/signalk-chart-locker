/** The stateful position-warm loop: on each navigation.position fix it decides (via shouldWarm) whether to
 * warm a small radius around the vessel, throttles, and backs off whenever the warm does not finish
 * successfully, so it does not fire roughly 16 fetches each blocking on the egress timeout every
 * interval. The container being healthy only means the container is up, not that the internet is up. */

import type { LngLatBbox } from 'signalk-chart-sources'
import type { Position } from '../shared/types.js'
import { MAX_WARM_ZOOM, type RegionsStore } from './regions-store.js'
import type { WarmResult } from './tilecache-client.js'
import { shouldWarm, bboxesAround, isValidPosition, type WarmTrigger } from './position-warm.js'

export interface PositionWarmer {
  onPosition (pos: Position): void
  stop (): Promise<void>
}

interface Deps {
  getStore: () => RegionsStore
  warm: (bbox: LngLatBbox, sources: string[], minzoom: number, maxzoom: number, regionId?: string, additionalBbox?: LngLatBbox, signal?: AbortSignal) => Promise<WarmResult | null>
  now?: () => number
  backoffSecs?: number
  onError?: (error: unknown) => void
}

/** A small zoom window around the configured base, capped to keep the warm at about 16 tiles. */
const ZOOM_SPREAD = 1
const DEFAULT_BACKOFF_SECS = 600

export function createPositionWarmer (deps: Deps): PositionWarmer {
  const now = deps.now ?? Date.now
  const backoffSecs = deps.backoffSecs ?? DEFAULT_BACKOFF_SECS
  const trigger: WarmTrigger = { lastPos: null, lastWarmMs: 0, backoffUntilMs: 0 }
  let inFlight = false
  let stopped = false
  let task: Promise<void> | null = null
  const controller = new AbortController()
  const backOff = (): void => { trigger.backoffUntilMs = now() + backoffSecs * 1000 }
  const reportError = (error: unknown): void => {
    try { deps.onError?.(error) } catch {}
  }

  return {
    onPosition (pos: Position): void {
      if (stopped || inFlight) return
      if (!isValidPosition(pos)) return
      const nowMs = now()
      if (nowMs < trigger.backoffUntilMs) return
      let store: RegionsStore
      try {
        store = deps.getStore()
      } catch (error) {
        backOff()
        reportError(error)
        return
      }
      const settings = store.positionWarm
      if (settings.sources.length === 0) return
      if (!shouldWarm(pos, store.regions, settings, trigger, nowMs)) return
      const bboxes = bboxesAround(pos, settings.radiusMeters)
      const minzoom = Math.max(0, settings.baseZoom - ZOOM_SPREAD)
      const maxzoom = Math.min(MAX_WARM_ZOOM, settings.baseZoom + ZOOM_SPREAD)
      inFlight = true
      // Single async IIFE so the backoff update and the inFlight reset land in one microtask
      // continuation, which flushes before the test's `await Promise.resolve()` resumes.
      // The inner try/catch handles every error; the outer .catch satisfies no-floating-promises.
      const operation = (async () => {
        try {
          const result = await deps.warm(bboxes[0]!, settings.sources, minzoom, maxzoom, undefined, bboxes[1], controller.signal)
          if (stopped) return
          if (result === null || result.state !== 'done' || result.errors > 0) {
            backOff()
          } else {
            trigger.lastPos = pos
            trigger.lastWarmMs = nowMs
          }
        } catch (error) {
          if (!stopped) {
            backOff()
            reportError(error)
          }
        } finally {
          inFlight = false
        }
      })()
      const tracked = operation.catch(() => {}).finally(() => {
        if (task === tracked) task = null
      })
      task = tracked
    },
    async stop (): Promise<void> {
      if (stopped) return
      stopped = true
      controller.abort()
      if (task !== null) await task
    }
  }
}
