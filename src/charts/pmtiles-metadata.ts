/** Decode and validate a PMTiles archive off disk, awaited before the chart is published, so bounds,
 * zoom, the tile format, and the vector layers are always present. Mirrors the webapp
 * src/shared/map/pmtiles-metadata.ts so the two stay in step. */

import type { LngLatBbox } from 'signalk-chart-sources'
import { open } from 'node:fs/promises'
import { type Header, PMTiles, TileType } from 'pmtiles'
import { PmtilesFileSource } from './pmtiles-file-source.js'

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
const FORMAT_BY_TILE_TYPE: Partial<Record<TileType, PmtilesFormat>> = {
  [TileType.Mvt]: 'mvt',
  [TileType.Png]: 'png',
  [TileType.Jpeg]: 'jpg',
  [TileType.Webp]: 'webp',
  [TileType.Avif]: 'avif'
}

// The header packs lon and lat as int32 over 1e7; the library has already divided by 1e7, so these
// are WGS84 degrees [west, south, east, north]. Omit a zero-area or inverted box rather than emit a
// degenerate rectangle a caller would treat as a real extent.
function boundsFromHeader (header: Header): LngLatBbox | undefined {
  const { minLon, minLat, maxLon, maxLat } = header
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return undefined
  if (minLon === maxLon || minLat >= maxLat) return undefined
  return [minLon, minLat, maxLon, maxLat]
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function vectorLayerIds (metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.vector_layers)) return []
  const ids: string[] = []
  for (const entry of metadata.vector_layers) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

function nameFrom (metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined
  const name = metadata.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

function message (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function decodePmtilesArchive (filePath: string): Promise<DecodeResult> {
  // Validate the magic and spec version off disk first, so a corrupt or non-PMTiles file yields a
  // clear error rather than an opaque library throw.
  let head: Buffer
  try {
    const handle = await open(filePath, 'r')
    try {
      head = Buffer.alloc(127)
      await handle.read(head, 0, 127, 0)
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
    const archive = new PMTiles(new PmtilesFileSource(filePath))
    header = await archive.getHeader()
    // Metadata is optional convenience data; a malformed block must not sink a readable archive.
    try {
      metadata = await archive.getMetadata()
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
