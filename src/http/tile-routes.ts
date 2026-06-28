/** Streams browser tile and style requests to the tilecache container, the only path browsers reach it by. */

import { Readable, type Writable } from 'node:stream'

type HeaderValue = string | string[] | undefined

/** The request fields the proxy reads, a structural subset of an express Request. */
export interface ProxyRequest {
  url: string
  headers: Record<string, HeaderValue>
  on(event: 'close', listener: () => void): void
}

/** The response surface the proxy uses, a structural subset of an express Response (a Writable plus a few methods). */
export interface ProxyResponse {
  status(code: number): ProxyResponse
  setHeader(name: string, value: string): void
  end(): void
  headersSent: boolean
}

/** The router SignalK passes to registerWithRouter (only the GET registration is used). */
export interface TileRouter {
  get(path: string, handler: (req: ProxyRequest, res: ProxyResponse) => void): void
}

export type ProxyFetch = (url: string, init: { headers: Record<string, string>, signal: AbortSignal }) => Promise<Response>

/** Upstream headers relayed to the browser verbatim, so the HTTP cache, range, and stale signal all work. */
const RELAYED_HEADERS = ['content-type', 'etag', 'content-range', 'accept-ranges', 'content-length', 'cache-control', 'x-tilecache', 'last-modified']
/** Statuses with no body: piping `Readable.fromWeb(null)` would throw, so end without a body. */
const BODYLESS = new Set([204, 304, 416])

/** Register the tile and style proxy routes plus a readiness probe on the SignalK-provided router. */
export function registerTileRoutes (router: TileRouter, getAddress: () => string | null, fetchImpl: ProxyFetch = (url, init) => fetch(url, init)): void {
  router.get('/tiles/ready', (_req, res) => {
    res.status(getAddress() !== null ? 200 : 503)
    res.end()
  })
  const proxy = (req: ProxyRequest, res: ProxyResponse): void => {
    // streamToContainer handles its own errors; the catch only satisfies no-floating-promises.
    streamToContainer(req, res, getAddress(), fetchImpl).catch(() => {})
  }
  router.get('/tile/:source/:z/:x/:y', proxy)
  router.get('/style/:source', proxy)
  router.get('/style/:source/*', proxy)
}

async function streamToContainer (req: ProxyRequest, res: ProxyResponse, address: string | null, fetchImpl: ProxyFetch): Promise<void> {
  if (address === null) {
    res.status(503)
    res.end()
    return
  }
  // Abort the upstream fetch when the browser cancels (MapLibre cancels tiles on every pan and zoom).
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  const forward: Record<string, string> = {}
  const range = req.headers.range
  if (typeof range === 'string') forward.range = range
  const inm = req.headers['if-none-match']
  if (typeof inm === 'string') forward['if-none-match'] = inm

  try {
    const upstream = await fetchImpl(`http://${address}${req.url}`, { headers: forward, signal: controller.signal })
    res.status(upstream.status)
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) res.setHeader(name, value)
    }
    if (BODYLESS.has(upstream.status) || upstream.body === null) {
      res.end()
      return
    }
    Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res as unknown as Writable)
  } catch {
    if (!res.headersSent) {
      res.status(502)
    }
    res.end()
  }
}
