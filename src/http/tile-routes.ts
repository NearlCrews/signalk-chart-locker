/** Streams browser tile and style requests to the tilecache container, the only path browsers reach it by. */

import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CONTAINER_FETCH_TIMEOUT_MS } from '../runtime/container-fetch.js'
import { PLUGIN_MOUNT_PATH } from '../shared/plugin-id.js'

type HeaderValue = string | string[] | undefined

/** The request fields the proxy reads, a structural subset of an express Request. */
export interface ProxyRequest {
  url: string
  headers: Record<string, HeaderValue>
  /** Express resolves this (honoring trust-proxy), used only as a scheme fallback for the style rewrite. */
  protocol?: string
  /** Express derives this through its trust-proxy setting. */
  hostname?: string
  on(event: 'close', listener: () => void): void
}

/** The response surface the proxy uses, a structural subset of an express Response (a Writable plus a few methods). */
interface ProxyResponse {
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
/** Freshness headers relayed on the REWRITTEN style document. The body is transformed (the sprite URL is
 * absolutized), so the upstream strong etag and content-length no longer describe it and are not relayed;
 * cache-control and last-modified are body-independent, so relaying them gives the style the same browser
 * caching every other proxied path gets instead of none. */
const STYLE_CACHE_HEADERS = ['cache-control', 'last-modified']
/** Statuses with no body: piping `Readable.fromWeb(null)` would throw, so end without a body. */
const BODYLESS = new Set([204, 304, 416])

/** A fetch signal that aborts on either the browser cancel (controller) or the container fetch timeout. */
function proxySignal (controller: AbortController): AbortSignal {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(CONTAINER_FETCH_TIMEOUT_MS)])
}

/** Relay the named upstream headers to the browser response, skipping any the upstream omitted. */
function relayHeaders (upstream: Response, res: ProxyResponse, names: readonly string[]): void {
  for (const name of names) {
    const value = upstream.headers.get(name)
    if (value !== null) res.setHeader(name, value)
  }
}

/** Register the tile and style proxy routes plus a readiness probe on the SignalK-provided router.
 * publicBase is the plugin's mount prefix (`/plugins/<id>`), used to build an absolute sprite URL. */
export function registerTileRoutes (router: TileRouter, getAddress: () => string | null, fetchImpl: ProxyFetch = (url, init) => fetch(url, init), publicBase = PLUGIN_MOUNT_PATH): void {
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

function publicOrigin (req: ProxyRequest): string {
  const protocol = req.protocol === 'https' ? 'https' : 'http'
  const trustedHostname = req.hostname
  const hostHeader = firstToken(req.headers.host)
  if (hostHeader !== undefined) {
    try {
      const parsed = new URL(`${protocol}://${hostHeader}`)
      const hostMatches = trustedHostname === undefined || parsed.hostname === trustedHostname
      if (hostMatches && parsed.username === '' && parsed.password === '' && parsed.pathname === '/') {
        return `${protocol}://${parsed.host}`
      }
    } catch {}
  }
  if (trustedHostname !== undefined && trustedHostname !== '') {
    const host = trustedHostname.includes(':') && !trustedHostname.startsWith('[')
      ? `[${trustedHostname}]`
      : trustedHostname
    return `${protocol}://${host}`
  }
  return `${protocol}://localhost`
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
    upstream = await fetchImpl(`http://${address}${req.url}`, { headers: {}, signal: proxySignal(controller) })
  } catch {
    if (!res.headersSent) res.status(502)
    res.end()
    return
  }

  // A non-2xx (or bodyless) response is relayed verbatim, like any other proxied path.
  if (upstream.status < 200 || upstream.status >= 300 || upstream.body === null) {
    res.status(upstream.status)
    relayHeaders(upstream, res, RELAYED_HEADERS)
    if (BODYLESS.has(upstream.status) || upstream.body === null) {
      res.end()
      return
    }
    try {
      await pipeline(
        Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        res as unknown as Writable
      )
    } catch {
      if (!res.headersSent) res.status(502)
      res.end()
    }
    return
  }

  let text: string
  try {
    text = await upstream.text()
  } catch {
    if (!res.headersSent) res.status(502)
    res.end()
    return
  }
  let style: { sprite?: unknown }
  try {
    style = JSON.parse(text) as { sprite?: unknown }
  } catch {
    // Not JSON after all: relay the body we already read, unchanged.
    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType !== null) res.setHeader('content-type', contentType)
    relayHeaders(upstream, res, STYLE_CACHE_HEADERS)
    res.end(text)
    return
  }

  if (typeof style.sprite === 'string') {
    const path = req.url.split('?')[0]
    style.sprite = `${publicOrigin(req)}${publicBase}${path}/sprite`
  }
  res.status(upstream.status)
  res.setHeader('content-type', 'application/json')
  relayHeaders(upstream, res, STYLE_CACHE_HEADERS)
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
    const upstream = await fetchImpl(`http://${address}${req.url}`, { headers: forward, signal: proxySignal(controller) })
    res.status(upstream.status)
    relayHeaders(upstream, res, RELAYED_HEADERS)
    if (BODYLESS.has(upstream.status) || upstream.body === null) {
      res.end()
      return
    }
    // The casts bridge two type-system gaps the runtime handles fine: the web ReadableStream from fetch
    // is not the node:stream/web type Readable.fromWeb is declared with, and the express Response is a
    // Writable structurally but not nominally. They are load-bearing; do not remove them.
    await pipeline(
      Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      res as unknown as Writable
    )
  } catch {
    if (!res.headersSent) {
      res.status(502)
    }
    res.end()
  }
}
