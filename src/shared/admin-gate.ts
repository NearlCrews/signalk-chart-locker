/**
 * Admin-gate the plugin's /api subtree, once per app. Plugin routers receive no authentication by
 * default, so every /api route sits behind the server's admin middleware. This helper installs that gate
 * exactly once per app and reports whether it is in place, so a caller mounts its route only when the gate
 * holds: a route that cannot be gated fails CLOSED (unmounted) rather than answering unauthenticated
 * callers. On an unsecured Signal K server every client is treated as admin, the standard Signal K behavior.
 * Shared: both the prewarm routes and the PMTiles chart-management routes gate the same /api subtree
 * through this one module, and the per-app WeakSet installs the middleware exactly once.
 */

import type { ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID } from './plugin-id.js'

/** Subtree to admin-gate, an absolute path under the mounted router. */
const API_PATH = `/plugins/${PLUGIN_ID}/api`

/** The slice of the server security strategy this module needs (not exposed on the ServerAPI type). */
interface SecurityAwareApp {
  securityStrategy: {
    addAdminMiddleware: (path: string) => void
  }
}

/** Apps whose /api subtree has already been gated, keyed by the app object so it is installed once per app. */
const gatedApps = new WeakSet<object>()

/**
 * Ensure the plugin's /api subtree is admin-gated on `app`, and report whether the gate is in place.
 * Idempotent: installed on the first successful call; later calls return true without re-installing.
 * Returns false when the server exposes no admin middleware or the install throws, so the caller fails closed.
 */
export function ensureApiAdminGate (app: ServerAPI): boolean {
  if (gatedApps.has(app)) return true
  try {
    const securityAware = app as unknown as Partial<SecurityAwareApp>
    if (typeof securityAware.securityStrategy?.addAdminMiddleware === 'function') {
      securityAware.securityStrategy.addAdminMiddleware(API_PATH)
      gatedApps.add(app)
      return true
    }
    app.error(`Cannot admin-gate ${API_PATH}: securityStrategy.addAdminMiddleware is unavailable`)
  } catch (error) {
    app.error(`Cannot admin-gate ${API_PATH}: ${String(error)}`)
  }
  return false
}
