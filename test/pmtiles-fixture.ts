/** Builds a minimal valid PMTiles v3 archive in memory for hermetic decode and serve tests.
 * Layout: a 127-byte header, then the JSON metadata block (uncompressed). Root, leaf, and tile
 * data sections are empty. All integers are little-endian; lon and lat are int32 scaled by 1e7. */
export interface FixtureOptions {
  magic?: string
  version?: number
  tileType?: number
  minZoom?: number
  maxZoom?: number
  minLonE7?: number
  minLatE7?: number
  maxLonE7?: number
  maxLatE7?: number
  centerZoom?: number
  metadata?: unknown
}

export function buildPmtilesFixture (opts: FixtureOptions = {}): Buffer {
  const meta = Buffer.from(
    JSON.stringify(opts.metadata ?? { name: 'Test Chart', vector_layers: [{ id: 'water' }] }),
    'utf8'
  )
  const header = Buffer.alloc(127)
  header.write(opts.magic ?? 'PMTiles', 0, 'ascii')
  header.writeUInt8(opts.version ?? 3, 7)
  const metaOffset = 127n
  const metaLen = BigInt(meta.length)
  const tail = 127n + metaLen
  header.writeBigUInt64LE(127n, 8) // root dir offset
  header.writeBigUInt64LE(0n, 16) // root dir length (empty)
  header.writeBigUInt64LE(metaOffset, 24) // json metadata offset
  header.writeBigUInt64LE(metaLen, 32) // json metadata length
  header.writeBigUInt64LE(tail, 40) // leaf dir offset
  header.writeBigUInt64LE(0n, 48) // leaf dir length
  header.writeBigUInt64LE(tail, 56) // tile data offset
  header.writeBigUInt64LE(0n, 64) // tile data length
  header.writeBigUInt64LE(0n, 72) // num addressed tiles
  header.writeBigUInt64LE(0n, 80) // num tile entries
  header.writeBigUInt64LE(0n, 88) // num tile contents
  header.writeUInt8(0, 96) // clustered
  header.writeUInt8(1, 97) // internal compression = None
  header.writeUInt8(1, 98) // tile compression = None
  header.writeUInt8(opts.tileType ?? 1, 99) // tile type (1 = Mvt)
  header.writeUInt8(opts.minZoom ?? 0, 100)
  header.writeUInt8(opts.maxZoom ?? 14, 101)
  header.writeInt32LE(opts.minLonE7 ?? -1220000000, 102) // -122.0
  header.writeInt32LE(opts.minLatE7 ?? 370000000, 106) // 37.0
  header.writeInt32LE(opts.maxLonE7 ?? -1210000000, 110) // -121.0
  header.writeInt32LE(opts.maxLatE7 ?? 380000000, 114) // 38.0
  header.writeUInt8(opts.centerZoom ?? 0, 118) // center zoom
  header.writeInt32LE(-1215000000, 119) // center lon
  header.writeInt32LE(375000000, 123) // center lat
  return Buffer.concat([header, meta])
}
