/** Decode and validate a PMTiles archive off disk, awaited before the chart is published, so bounds,
 * zoom, the tile format, and the vector layers are always present. Mirrors the webapp
 * src/shared/map/pmtiles-metadata.ts so the two stay in step. */

import type { LngLatBbox } from 'signalk-chart-sources'
import { open } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { Compression, type Header, PMTiles, TileType } from 'pmtiles'
import { PmtilesFileSource } from './pmtiles-file-source.js'
import { hasControlCharacter } from '../shared/text.js'

type PmtilesFormat = 'mvt' | 'png' | 'jpg' | 'webp' | 'avif'

export interface DecodedPmtiles {
  minzoom: number
  maxzoom: number
  bounds?: LngLatBbox
  format: PmtilesFormat
  vectorLayers: string[]
  name?: string
}

export type DecodeResult = { ok: true, decoded: DecodedPmtiles } | { ok: false, error: string }

const MAGIC = 'PMTiles'
const SPEC_VERSION = 3
const HEADER_BYTES = 127
const MAX_SAFE_ZOOM = 26
const MAX_METADATA_COMPRESSED_BYTES = 1024 * 1024
const MAX_METADATA_DECOMPRESSED_BYTES = 4 * 1024 * 1024
const MAX_METADATA_NAME_LENGTH = 512
const MAX_VECTOR_LAYER_ID_LENGTH = 256
const MAX_VECTOR_LAYERS = 4096
const FORMAT_BY_TILE_TYPE: Partial<Record<TileType, PmtilesFormat>> = {
  [TileType.Mvt]: 'mvt',
  [TileType.Png]: 'png',
  [TileType.Jpeg]: 'jpg',
  [TileType.Webp]: 'webp',
  [TileType.Avif]: 'avif'
}

interface DecodeDeps {
  open?: typeof open
}

type FileHandle = Awaited<ReturnType<typeof open>>

async function readExact (handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let bytesRead = 0
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, position + bytesRead)
    if (result.bytesRead === 0) break
    bytesRead += result.bytesRead
  }
  return bytesRead
}

// The header packs lon and lat as int32 over 1e7; the library has already divided by 1e7, so these
// are WGS84 degrees [west, south, east, north]. Omit a zero-area or inverted box rather than emit a
// degenerate rectangle a caller would treat as a real extent.
function boundsFromHeader (header: Header): LngLatBbox | undefined {
  const { minLon, minLat, maxLon, maxLat } = header
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return undefined
  if (minLon < -180 || minLon > 180 || maxLon < -180 || maxLon > 180 ||
      minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90) return undefined
  if (minLon === maxLon || minLat >= maxLat) return undefined
  return [minLon, minLat, maxLon, maxLat]
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function vectorLayerIds (metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.vector_layers)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of metadata.vector_layers) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== 'string') continue
    const normalized = id.trim()
    if (normalized.length === 0 || normalized.length > MAX_VECTOR_LAYER_ID_LENGTH ||
        hasControlCharacter(id) || seen.has(normalized)) continue
    seen.add(normalized)
    ids.push(normalized)
    if (ids.length >= MAX_VECTOR_LAYERS) break
  }
  return ids
}

function nameFrom (metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined
  const name = metadata.name
  if (typeof name !== 'string') return undefined
  const normalized = name.trim()
  return normalized.length > 0 && normalized.length <= MAX_METADATA_NAME_LENGTH && !hasControlCharacter(name)
    ? normalized
    : undefined
}

function message (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function validSection (offset: number, length: number, fileSize: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0 &&
    offset <= fileSize && length <= fileSize - offset
}

async function readMetadata (source: PmtilesFileSource, header: Header, fileSize: number): Promise<unknown> {
  if (header.jsonMetadataLength === 0) return undefined
  if (!validSection(header.jsonMetadataOffset, header.jsonMetadataLength, fileSize) ||
      header.jsonMetadataLength > MAX_METADATA_COMPRESSED_BYTES) throw new Error('metadata section is invalid or too large')
  const range = await source.getBytes(header.jsonMetadataOffset, header.jsonMetadataLength)
  const compressed = Buffer.from(range.data)
  let decoded: Buffer
  if (header.internalCompression === Compression.None) {
    if (compressed.length > MAX_METADATA_DECOMPRESSED_BYTES) throw new Error('metadata is too large')
    decoded = compressed
  } else if (header.internalCompression === Compression.Gzip) {
    decoded = gunzipSync(compressed, { maxOutputLength: MAX_METADATA_DECOMPRESSED_BYTES })
  } else {
    throw new Error(`unsupported metadata compression ${header.internalCompression}`)
  }
  return JSON.parse(decoded.toString('utf8')) as unknown
}

export async function decodePmtilesArchive (filePath: string, deps: DecodeDeps = {}): Promise<DecodeResult> {
  // Validate the magic and spec version off disk first, so a corrupt or non-PMTiles file yields a
  // clear error rather than an opaque library throw.
  let head: Buffer
  let fileSize: number
  try {
    const handle = await (deps.open ?? open)(filePath, 'r')
    try {
      const info = await handle.stat()
      fileSize = info.size
      head = Buffer.alloc(HEADER_BYTES)
      const bytesRead = await readExact(handle, head, 0)
      if (bytesRead !== HEADER_BYTES) throw new Error('truncated PMTiles header')
    } finally {
      await handle.close()
    }
  } catch (err) {
    return { ok: false, error: `cannot read archive: ${message(err)}` }
  }
  if (head.subarray(0, 7).toString('ascii') !== MAGIC) {
    return { ok: false, error: 'not a PMTiles archive (bad magic)' }
  }
  const version = head.readUInt8(7)
  if (version !== SPEC_VERSION) {
    return { ok: false, error: `unsupported PMTiles spec version ${version}` }
  }

  let header: Header
  let metadata: unknown
  try {
    const source = new PmtilesFileSource(filePath)
    const archive = new PMTiles(source)
    header = await archive.getHeader()
    const sections: Array<[number, number]> = [
      [header.rootDirectoryOffset, header.rootDirectoryLength],
      [header.jsonMetadataOffset, header.jsonMetadataLength],
      [header.leafDirectoryOffset, header.leafDirectoryLength ?? 0],
      [header.tileDataOffset, header.tileDataLength ?? 0]
    ]
    for (const [offset, length] of sections) {
      if (!validSection(offset, length, fileSize)) throw new Error('archive section falls outside the file')
    }
    if (!Number.isInteger(header.minZoom) || !Number.isInteger(header.maxZoom) ||
        header.minZoom < 0 || header.maxZoom > MAX_SAFE_ZOOM || header.minZoom > header.maxZoom) {
      throw new Error(`invalid zoom range ${header.minZoom}-${header.maxZoom}`)
    }
    // Metadata is optional convenience data; a malformed block must not sink a readable archive.
    try {
      metadata = await readMetadata(source, header, fileSize)
    } catch {
      metadata = undefined
    }
  } catch (err) {
    return { ok: false, error: `failed to decode header: ${message(err)}` }
  }

  const format = FORMAT_BY_TILE_TYPE[header.tileType]
  if (!format) {
    return { ok: false, error: `unknown tile type ${header.tileType}` }
  }
  return {
    ok: true,
    decoded: {
      minzoom: header.minZoom,
      maxzoom: header.maxZoom,
      bounds: boundsFromHeader(header),
      format,
      vectorLayers: vectorLayerIds(metadata),
      name: nameFrom(metadata)
    }
  }
}
