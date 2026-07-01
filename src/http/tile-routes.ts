/** Streams browser tile and style requests to the tilecache container, the only path browsers reach it by. */

import { Readable, type Writable } from 'node:stream'
import { CONTAINER_FETCH_TIMEOUT_MS } from '../runtime/container-fetch.js'

type HeaderValue = string | string[] | undefined

/** The request fields the proxy reads, a structural subset of an express Request. */
export interface ProxyRequest {
  url: string
  headers: Record<string, HeaderValue>
  /** Express resolves this (honoring trust-proxy), used only as a scheme fallback for the style rewrite. */
  protocol?: string
  on(event: 'close', listener: () => void): void
}

/** The response surface the proxy uses, a structural subset of an express Response (a Writable plus a few methods). */
export interface ProxyResponse {
  status(code: number): ProxyResponse
  setHeader(name: string, value: string): void
  /** A body argument is used by the style route, which buffers and rewrites instead of streaming. */
  end(body?: string): void
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

/** Register the tile and style proxy routes plus a readiness probe on the SignalK-provided router.
 * publicBase is the plugin's mount prefix (`/plugins/<id>`), used to build an absolute sprite URL. */
export function registerTileRoutes (router: TileRouter, getAddress: () => string | null, fetchImpl: ProxyFetch = (url, init) => fetch(url, init), publicBase = '/plugins/signalk-chart-locker'): void {
  router.get('/tiles/ready', (_req, res) => {
    res.status(getAddress() !== null ? 200 : 503)
    res.end()
  })
  const proxy = (req: ProxyRequest, res: ProxyResponse): void => {
    // streamToContainer handles its own errors; the catch only satisfies no-floating-promises.
    streamToContainer(req, res, getAddress(), fetchImpl).catch(() => {})
  }
  // The style document is buffered and rewritten (not streamed) so the sprite URL can be made absolute;
  // its sprite, glyph, and tile subpaths under /style/:source/* keep streaming through the proxy.
  const styleProxy = (req: ProxyRequest, res: ProxyResponse): void => {
    rewriteStyleSprite(req, res, getAddress(), publicBase, fetchImpl).catch(() => {})
  }
  router.get('/tile/:source/:z/:x/:y', proxy)
  router.get('/style/:source', styleProxy)
  router.get('/style/:source/*', proxy)
}

/** The first comma-separated token of a header (proxy chains join X-Forwarded-* with commas), trimmed. */
function firstToken (value: HeaderValue): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return undefined
  const token = raw.split(',')[0]?.trim()
  return token !== undefined && token !== '' ? token : undefined
}

/** Serve GET /style/:source: rewrite the sprite to an absolute same-origin URL so MapLibre accepts it
 * (it rejects a path-absolute sprite at parse time) and the existing /style/:source/* proxy serves the
 * cached sprite offline. Everything but the sprite field is passed through unchanged. */
async function rewriteStyleSprite (req: ProxyRequest, res: ProxyResponse, address: string | null, publicBase: string, fetchImpl: ProxyFetch): Promise<void> {
  if (address === null) {
    res.status(503)
    res.end()
    return
  }
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream: Response
  try {
    upstream = await fetchImpl(`http://${address}${req.url}`, { headers: {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)]) })
  } catch {
    if (!res.headersSent) res.status(502)
    res.end()
    return
  }

  // A non-2xx (or bodyless) response is relayed verbatim, like any other proxied path.
  if (upstream.status < 200 || upstream.status >= 300 || upstream.body === null) {
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
    return
  }

  const text = await upstream.text()
  let style: { sprite?: unknown }
  try {
    style = JSON.parse(text) as { sprite?: unknown }
  } catch {
    // Not JSON after all: relay the body we already read, unchanged.
    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType !== null) res.setHeader('content-type', contentType)
    res.end(text)
    return
  }

  if (typeof style.sprite === 'string') {
    const proto = firstToken(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http'
    const host = firstToken(req.headers['x-forwarded-host']) ?? firstToken(req.headers.host) ?? ''
    const path = req.url.split('?')[0]
    style.sprite = `${proto}://${host}${publicBase}${path}/sprite`
  }
  res.status(upstream.status)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(style))
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
    const upstream = await fetchImpl(`http://${address}${req.url}`, { headers: forward, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)]) })
    res.status(upstream.status)
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) res.setHeader(name, value)
    }
    if (BODYLESS.has(upstream.status) || upstream.body === null) {
      res.end()
      return
    }
    // The casts bridge two type-system gaps the runtime handles fine: the web ReadableStream from fetch
    // is not the node:stream/web type Readable.fromWeb is declared with, and the express Response is a
    // Writable structurally but not nominally. They are load-bearing; do not remove them.
    Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res as unknown as Writable)
  } catch {
    if (!res.headersSent) {
      res.status(502)
    }
    res.end()
  }
}
