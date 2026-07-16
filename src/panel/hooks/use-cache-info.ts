/**
 * React hook that fetches the plugin's cache-info route once on mount. The route reports the free
 * space on the selected cache filesystem and a recommended cache cap, which the browser panel cannot
 * compute itself. It runs inside the admin's authenticated session, so the same-origin request is
 * transparently authorized. The fetch is one-shot: free space changes slowly, and the panel reads it
 * only to seed the default and to warn when the cap exceeds free space.
 */

import { useEffect, useState } from 'react'
import { PLUGIN_ID } from '../../shared/plugin-id.js'
import { useAbortableFetch } from './use-abortable-fetch.js'

/** The admin-gated cache-info route, under this plugin's mount. Same-origin, gated by the session. */
const CACHE_INFO_URL = `/plugins/${PLUGIN_ID}/api/cache-info`

/** The cache-info surface the panel consumes. */
export interface UseCacheInfoResult {
  /** Free GiB on the effective cache filesystem, or null before detection succeeds. */
  freeGiB: number | null
  /** The recommended cache cap in GiB, or null until the fetch resolves. */
  recommendedCapGiB: number | null
  storage: 'data-directory' | 'external' | 'unknown'
  usingFallback: boolean
  /** Human-readable fetch failure, or null when guidance loaded successfully. */
  error: string | null
}

/** Read a value off the raw response as a finite number, else null. */
function readFiniteNumber (value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Fetch the cache-info route once and expose the free space and the recommended cap. */
export function useCacheInfo (): UseCacheInfoResult {
  const [freeGiB, setFreeGiB] = useState<number | null>(null)
  const [recommendedCapGiB, setRecommendedCapGiB] = useState<number | null>(null)
  const [storage, setStorage] = useState<UseCacheInfoResult['storage']>('unknown')
  const [usingFallback, setUsingFallback] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetcher = useAbortableFetch()

  useEffect(() => {
    // A fetch failure here is non-fatal: this only seeds the default cap and the free-space note, so on
    // failure the values stay null and the panel falls back to the static default.
    async function load (): Promise<void> {
      try {
        const parsed = await fetcher.fetchJson(CACHE_INFO_URL) as { freeGiB?: unknown, recommendedCapGiB?: unknown, storage?: unknown, usingFallback?: unknown }
        if (fetcher.canceled()) return
        setFreeGiB(readFiniteNumber(parsed.freeGiB))
        setRecommendedCapGiB(readFiniteNumber(parsed.recommendedCapGiB))
        setStorage(parsed.storage === 'external' || parsed.storage === 'data-directory' ? parsed.storage : 'unknown')
        setUsingFallback(parsed.usingFallback === true)
        setError(null)
      } catch (cause) {
        // Non-fatal: leave the values null so the panel keeps the static default, but explain why
        // filesystem-specific guidance is unavailable.
        if (!fetcher.canceled()) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    load()
  }, [fetcher])

  return { freeGiB, recommendedCapGiB, storage, usingFallback, error }
}
