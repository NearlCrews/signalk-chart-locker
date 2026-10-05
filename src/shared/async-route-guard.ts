/**
 * Guard the plugin's /api route handlers. Express 4 ignores the promise an async handler returns, so a
 * rejection would leave the request open and reach the process as an unhandled rejection. The plugin
 * hands every /api registrar the router this returns, so a failing handler answers 500 instead and its
 * detail goes only to the debug log.
 */

/** The response surface the guard answers through. */
interface GuardedResponse {
  status (code: number): { json (body: unknown): void }
  headersSent?: boolean
}

type GuardedHandler = (req: unknown, res: GuardedResponse) => unknown

/** The route-mounting surface the /api registrars use. */
export interface ApiRouter {
  get (path: string, handler: GuardedHandler): void
  post (path: string, handler: GuardedHandler): void
  delete (path: string, handler: GuardedHandler): void
}

/** Wrap `router` so every handler mounted through it answers 500 rather than rejecting. */
export function guardAsyncRoutes (router: ApiRouter, onError: (error: unknown) => void): ApiRouter {
  const guard = (handler: GuardedHandler): GuardedHandler => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      onError(error)
      if (res.headersSent !== true) res.status(500).json({ error: 'internal error' })
    }
  }
  return {
    get (path, handler) { router.get(path, guard(handler)) },
    post (path, handler) { router.post(path, guard(handler)) },
    delete (path, handler) { router.delete(path, guard(handler)) }
  }
}
