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
        const signals = [AbortSignal.timeout(PANEL_REQUEST_TIMEOUT_MS)]
        if (unmountRef.current !== null) signals.push(unmountRef.current.signal)
        const response = await fetch(url, { ...init, credentials: 'same-origin', signal: AbortSignal.any(signals) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response
      },
      async fetchJson (url: string, init: RequestInit = {}): Promise<unknown> {
        const response = await apiRef.current!.request(url, init)
        return response.json()
      },
      canceled: () => canceledRef.current
    }
  }
  return apiRef.current
}
