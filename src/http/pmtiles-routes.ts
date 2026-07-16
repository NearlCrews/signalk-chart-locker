/** Serve a discovered PMTiles archive over a Range-capable route with a strong ETag minted from file
 * identity (device, inode, size, and mtime in nanoseconds), so the browser HTTP cache and the
 * pmtiles library work
 * without the cache: 'no-store' workaround. The ETag is never a hash of the 127-byte header: a
 * re-exported archive with a byte-identical header must still get a new ETag. The route is open
 * read-only; an unknown id returns 404, and an id can never reach a file outside the discovered set. */

import { closeSync, constants, createReadStream, fstatSync, openSync, type ReadStream } from 'node:fs'
import { type Writable } from 'node:stream'
import { nameToId } from '../charts/chart-id.js'
import type { ChartRegistry } from '../charts/chart-registry.js'

const PMTILES_SERVE_PATH = '/pmtiles/:file'
const NO_SNIFF_HEADER = 'X-Content-Type-Options'

export interface ServeRequest {
  params: { file: string }
  headers: Record<string, string | string[] | undefined>
  /** Express dispatches HEAD through a matching GET route when no explicit HEAD route exists. */
  method?: string
}

interface ServeResponse {
  status (code: number): ServeResponse
  setHeader (name: string, value: string): void
  removeHeader? (name: string): void
  end (body?: string): void
  headersSent: boolean
  destroyed?: boolean
  destroy? (error?: Error): void
}

export interface ServeRouter {
  get (path: string, handler: (req: ServeRequest, res: ServeResponse) => void): void
}

interface ServeDeps {
  createReadStream?: typeof createReadStream
  onStream?: (stream: ReadStream) => void
}

function header (value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function weakEntityTag (value: string): string | undefined {
  const match = /^(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")$/.exec(value.trim())
  return match?.[1]
}

function entityTagList (raw: string): string[] | undefined {
  const tags: string[] = []
  let index = 0
  while (index < raw.length) {
    while (raw[index] === ' ' || raw[index] === '\t') index++
    const start = index
    if (raw.slice(index, index + 2) === 'W/') index += 2
    if (raw[index] !== '"') return undefined
    index++
    while (index < raw.length && raw[index] !== '"') {
      const code = raw.charCodeAt(index)
      if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || code >= 0x80)) return undefined
      index++
    }
    if (raw[index] !== '"') return undefined
    index++
    tags.push(raw.slice(start, index))
    while (raw[index] === ' ' || raw[index] === '\t') index++
    if (index === raw.length) return tags
    if (raw[index] !== ',') return undefined
    index++
  }
  return undefined
}

/** GET and HEAD use weak comparison for every entity tag in If-None-Match. */
function matchesIfNoneMatch (raw: string | undefined, etag: string): boolean {
  if (raw?.trim() === '*') return true
  const current = weakEntityTag(etag)
  if (raw === undefined || current === undefined) return false
  const candidates = entityTagList(raw) ?? []
  return candidates.some((candidate) => weakEntityTag(candidate) === current)
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

export function registerPmtilesServeRoute (router: ServeRouter, registry: ChartRegistry, isEnabled: () => boolean = () => true, deps: ServeDeps = {}): void {
  router.get(PMTILES_SERVE_PATH, (req, res) => {
    res.setHeader(NO_SNIFF_HEADER, 'nosniff')
    if (!isEnabled()) {
      res.status(409).end('PMTiles serving is disabled while pmtiles-chart-provider is enabled')
      return
    }
    serve(req, res, registry, deps)
  })
}

function serve (req: ServeRequest, res: ServeResponse, registry: ChartRegistry, deps: ServeDeps): void {
  const record = registry.record(nameToId(req.params.file))
  if (!record) {
    res.status(404).end('Not found')
    return
  }
  const { filePath } = record
  // Open with O_NOFOLLOW where the platform supports it, then require the descriptor to have the
  // identity captured during discovery. Windows does not enforce O_NOFOLLOW, so the identity check
  // also prevents a replaced path or symlink target from being served there. createReadStream receives
  // this descriptor, so the file that was checked is exactly the file that is streamed.
  let fd: number | undefined
  let size: number
  let etag: string
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile()) throw new Error('not a regular file')
    if (record.device === undefined || record.inode === undefined || record.bytes === undefined ||
        record.mtimeNs === undefined || info.dev !== record.device || info.ino !== record.inode ||
        info.size !== BigInt(record.bytes) || info.mtimeNs !== record.mtimeNs) {
      throw new Error('file identity changed after discovery')
    }
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
  // Archives are mutable at a stable URL. Permit storage, but require validation before reuse so an
  // atomic replacement is observed through the strong file-identity ETag.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
  const isHead = req.method?.toUpperCase() === 'HEAD'

  // If-None-Match takes precedence over Range (RFC 9110): a matching validator returns 304 regardless of a
  // Range header, rather than a 206. The wildcard '*' means any representation exists.
  const rangeHeader = header(req.headers.range)
  const ifNoneMatchHeader = header(req.headers['if-none-match'])
  if (matchesIfNoneMatch(ifNoneMatchHeader, etag)) {
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
    if (isHead) {
      closeSync(fd)
      res.end()
      return
    }
    let stream: ReadStream
    try {
      stream = (deps.createReadStream ?? createReadStream)(filePath, { fd, autoClose: true, start: range.start, end: range.end })
    } catch {
      try { closeSync(fd) } catch {}
      clearRepresentationHeaders(res)
      res.status(500).end()
      return
    }
    try {
      deps.onStream?.(stream)
    } catch {
      stream.destroy()
      clearRepresentationHeaders(res)
      res.status(500).end()
      return
    }
    pipeStream(stream, res)
    return
  }

  res.setHeader('Content-Length', String(size))
  res.status(200)
  if (isHead) {
    closeSync(fd)
    res.end()
    return
  }
  let stream: ReadStream
  try {
    stream = (deps.createReadStream ?? createReadStream)(filePath, { fd, autoClose: true })
  } catch {
    try { closeSync(fd) } catch {}
    clearRepresentationHeaders(res)
    res.status(500).end()
    return
  }
  try {
    deps.onStream?.(stream)
  } catch {
    stream.destroy()
    clearRepresentationHeaders(res)
    res.status(500).end()
    return
  }
  pipeStream(stream, res)
}

function clearRepresentationHeaders (res: ServeResponse): void {
  for (const header of ['Accept-Ranges', 'ETag', 'Content-Type', 'Cache-Control', 'Content-Length', 'Content-Range']) {
    res.removeHeader?.(header)
  }
}

function pipeStream (stream: NodeJS.ReadableStream, res: ServeResponse): void {
  const source = stream as NodeJS.ReadableStream & { destroyed?: boolean, destroy: (error?: Error) => void }
  const destination = res as unknown as Writable
  let completed = false
  const cleanup = (): void => {
    source.removeListener('error', onSourceError)
    destination.removeListener('finish', onFinish)
    destination.removeListener('close', onClose)
  }
  const onFinish = (): void => {
    completed = true
    cleanup()
  }
  const onClose = (): void => {
    if (!completed && source.destroyed !== true) source.destroy()
    cleanup()
  }
  const onSourceError = (error: Error): void => {
    if (!res.headersSent && destination.destroyed !== true) {
      clearRepresentationHeaders(res)
      res.status(500)
      res.end()
    } else if (destination.destroyed !== true) {
      destination.destroy(error)
    }
  }
  source.once('error', onSourceError)
  destination.once('finish', onFinish)
  destination.once('close', onClose)
  source.pipe(destination)
}
