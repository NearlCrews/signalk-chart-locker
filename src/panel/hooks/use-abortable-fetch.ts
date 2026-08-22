/**
 * Shared fetch scaffolding for every panel HTTP hook. It owns the per-mount abort
 * controller (fired on unmount) and mints a fresh timeout signal per call, so a slow request cannot
 * hang past the panel's timeout and an outstanding request does not run against an unmounted component.
 * The returned object is stable across renders, so callers can safely reference it from an effect.
 */

import { useEffect, useRef } from 'react'
import { PANEL_REQUEST_TIMEOUT_MS } from '../request-timeout.js'

export interface AbortableFetch {
  request: (url: string, init?: RequestInit) => Promise<Response>
  /** Fetch the URL with same-origin credentials, a fresh per-call timeout, and unmount abort. Rejects
   *  with Error 'HTTP <status>' on a non-2xx, and rejects on a transport error or an abort. */
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>
  /** True once the component has unmounted, so a caller can skip a state update from a late response. */
  canceled: () => boolean
  /** True when a rejection must not reach the operator: see `isTeardownAbort`. */
  abandoned: (cause: unknown) => boolean
}

/**
 * Whether a rejection is this hook's own teardown rather than a real failure.
 *
 * `canceled()` reports whether the component is unmounted *now*, which is not the same question as
 * whether a given in-flight request was superseded. React StrictMode tears the panel down and
 * remounts it synchronously, so a request issued before the teardown rejects with its abort after
 * the remount has already cleared the unmount flag, and a caller that trusted the flag alone would
 * report the teardown as a live failure.
 *
 * An abort from a controller carries `AbortError`, while an expired `AbortSignal.timeout` carries
 * `TimeoutError`. Only the former is ours to swallow: a request that genuinely ran out of time is a
 * failure the operator needs to see.
 */
export function isTeardownAbort (cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

export function useAbortableFetch (): AbortableFetch {
  const unmountRef = useRef<AbortController | null>(null)
  const canceledRef = useRef(false)

  useEffect(() => {
    canceledRef.current = false
    const controller = new AbortController()
    unmountRef.current = controller
    return () => {
      canceledRef.current = true
      controller.abort()
    }
  }, [])

  // Built once: the closures capture only stable refs, so the object identity stays constant.
  const apiRef = useRef<AbortableFetch | null>(null)
  if (apiRef.current === null) {
    apiRef.current = {
      async request (url: string, init: RequestInit = {}): Promise<Response> {
        // A fresh timeout per call: a single hook-lifetime timeout would abort every later poll.
        const unmountSignal = unmountRef.current?.signal
        const signals = [AbortSignal.timeout(PANEL_REQUEST_TIMEOUT_MS)]
        if (unmountSignal !== undefined) signals.push(unmountSignal)
        if (init.signal !== undefined && init.signal !== null) signals.push(init.signal)
        try {
          const response = await fetch(url, { ...init, credentials: 'same-origin', signal: AbortSignal.any(signals) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response
        } catch (cause) {
          // Both our teardown and a caller's own controller abort with AbortError, so without this the
          // caller's deliberate cancellation would be swallowed as if the panel had unmounted. Only the
          // teardown signal being aborted proves the abort was ours. No caller passes a signal today;
          // this keeps the first one that does from silently losing its failures.
          if (isTeardownAbort(cause) && unmountSignal?.aborted !== true) {
            throw new DOMException('The panel request was aborted by its caller.', 'CallerAbortError')
          }
          throw cause
        }
      },
      async fetchJson (url: string, init: RequestInit = {}): Promise<unknown> {
        const response = await apiRef.current!.request(url, init)
        return response.json()
      },
      canceled: () => canceledRef.current,
      abandoned: (cause: unknown) => canceledRef.current || isTeardownAbort(cause)
    }
  }
  return apiRef.current
}
