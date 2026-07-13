/** Serve a discovered PMTiles archive over a Range-capable route with a strong ETag minted from file
 * identity (device, inode, size, and mtime in nanoseconds), so the browser HTTP cache and the
 * pmtiles library work
 * without the cache: 'no-store' workaround. The ETag is never a hash of the 127-byte header: a
 * re-exported archive with a byte-identical header must still get a new ETag. The route is open
 * read-only; an unknown id returns 404, and an id can never reach a file outside the discovered set. */

import { closeSync, constants, createReadStream, fstatSync, openSync } from 'node:fs'
import { type Writable } from 'node:stream'
import { nameToId } from '../charts/chart-id.js'
import type { ChartRegistry } from '../charts/chart-registry.js'

const PMTILES_SERVE_PATH = '/pmtiles/:file'

export interface ServeRequest {
  params: { file: string }
  headers: Record<string, string | string[] | undefined>
}

interface ServeResponse {
  status (code: number): ServeResponse
  setHeader (name: string, value: string): void
  end (body?: string): void
  headersSent: boolean
}

export interface ServeRouter {
  get (path: string, handler: (req: ServeRequest, res: ServeResponse) => void): void
}

function header (value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

// Parse a single-range "bytes=start-end" against the file size. Returns null for a malformed or
// multi-range header (served as a full 200), and 'unsatisfiable' when the range falls outside.
function parseRange (raw: string | undefined, size: number): { start: number, end: number } | 'unsatisfiable' | null {
  if (!raw) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

export function registerPmtilesServeRoute (router: ServeRouter, registry: ChartRegistry, isEnabled: () => boolean = () => true): void {
  router.get(PMTILES_SERVE_PATH, (req, res) => {
    if (!isEnabled()) {
      res.status(409).end('PMTiles serving is disabled while pmtiles-chart-provider is enabled')
      return
    }
    serve(req, res, registry)
  })
}

function serve (req: ServeRequest, res: ServeResponse, registry: ChartRegistry): void {
  const filePath = registry.filePathFor(nameToId(req.params.file))
  if (!filePath) {
    res.status(404).end('Not found')
    return
  }
  // Open with O_NOFOLLOW, then validate the opened descriptor. createReadStream receives this descriptor,
  // so the file that was checked is exactly the file that is streamed even if the path is replaced later.
  let fd: number | undefined
  let size: number
  let etag: string
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile()) throw new Error('not a regular file')
    size = Number(info.size)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('file is too large')
    etag = `"${info.dev}-${info.ino}-${info.size}-${info.mtimeNs}"`
  } catch {
    if (fd !== undefined) closeSync(fd)
    res.status(404).end('Not found')
    return
  }

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('ETag', etag)
  res.setHeader('Content-Type', 'application/octet-stream')

  // If-None-Match takes precedence over Range (RFC 9110): a matching validator returns 304 regardless of a
  // Range header, rather than a 206. The wildcard '*' means any representation exists.
  const rangeHeader = header(req.headers.range)
  const ifNoneMatch = header(req.headers['if-none-match'])
  if (ifNoneMatch === '*' || ifNoneMatch === etag) {
    closeSync(fd)
    res.status(304).end()
    return
  }

  // If-Range guards the conditional range: a validator that does not match falls back to the full 200,
  // never a 206 against a stale validator.
  const ifRange = header(req.headers['if-range'])
  const honorRange = !ifRange || ifRange === etag
  const range = honorRange ? parseRange(rangeHeader, size) : null

  if (range === 'unsatisfiable') {
    closeSync(fd)
    res.setHeader('Content-Range', `bytes */${size}`)
    res.status(416).end()
    return
  }

  if (range) {
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    res.setHeader('Content-Length', String(range.end - range.start + 1))
    res.status(206)
    pipeStream(createReadStream(filePath, { fd, autoClose: true, start: range.start, end: range.end }), res)
    return
  }

  res.setHeader('Content-Length', String(size))
  res.status(200)
  pipeStream(createReadStream(filePath, { fd, autoClose: true }), res)
}

function pipeStream (stream: NodeJS.ReadableStream, res: ServeResponse): void {
  stream.on('error', () => {
    if (!res.headersSent) res.status(500)
    res.end()
  })
  ;(stream as NodeJS.ReadableStream & { pipe: (dest: Writable) => void }).pipe(res as unknown as Writable)
}
