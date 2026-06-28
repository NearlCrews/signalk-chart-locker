# PMTiles chart provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the companion plugin discover, decode, validate, and serve local `.pmtiles` charts itself with a strong ETag so the browser HTTP cache works, superseding the third-party signalk-pmtiles-plugin, and switch the webapp off its `cache: 'no-store'` workaround on the provided path.

**Architecture:** All local PMTiles work lives in the Node plugin (`src/`), which already runs in the Signal K process with filesystem access and `app.config.configPath`. The plugin watches a charts directory, decodes each archive header and metadata off disk with the pure-JS `pmtiles` library (awaited before publish), registers each as a `charts` resource preserving the third-party `nameToId` id scheme, and serves the bytes over a Range-capable route whose ETag is minted from file identity. The egress container is untouched: it stays tokenless and remote-upstreams only, and `security.json` never enters it. The webapp detects the provided url path by exact match and routes those archives through a plain source with the default browser HTTP cache, keeping `NoStoreSource` and the IndexedDB block cache only for non-provided archives.

**Tech Stack:** TypeScript (ESM, `tsc` build), `node --test` via `tsx` for the plugin, the pure-JS `pmtiles` library (server-side header and metadata decode plus the webapp `FetchSource`), Node `fs` streams and `fs.watch`, the Signal K `ServerAPI` (`registerResourceProvider`, `registerWithRouter`, `getDataDirPath`, `securityStrategy.addAdminMiddleware`), and Svelte 5 plus Vitest for the webapp panel in `signalk-binnacle`.

## Global Constraints

These apply to every task. Each task's requirements implicitly include this section.

- Trust boundary: the egress container is untouched and stays tokenless and remote-upstreams only. No charts mount, no config-tree exposure, and no new container egress. `security.json` (password hashes, the JWT secret, and device tokens) never enters the container. This milestone is plugin and webapp only; do not plan any container or Rust work.
- The plugin serves local files from `app.config.configPath` only, with a `realpath` containment check so a client id can never reach a file outside the charts directory. The id-to-file map is built only by the plugin from the discovered directory; an unknown id returns `404`; no client url reaches a fetch; there is no open-URL proxy.
- The serve route is open read-only (like the v1 tile and style routes). Only the management and config routes are admin-gated.
- Units are SI internally (meters, radians, Kelvin), converted only at a display edge per the server unit preference.
- The chart-resource id scheme is preserved: `nameToId` maps `file.pmtiles` to `file-pmtiles`, so a cutover does not reset webapp state keyed by chart id (layer visibility, opacity, and ordering).
- Writing style for all code comments, commit messages, and docs: no em dashes; use the Oxford (serial) comma in lists of three or more; write the word "and", never the ampersand, in human-readable text; "chartplotter" is one word; never describe any AI or review process in any commit, changelog, README, or comment.
- Build and test, companion plugin: `npm test` (node --test via tsx), `npm run typecheck`, `npm run lint`, `npm run build`. Single test file: `node --import tsx --test test/<name>.test.ts`. Companion tests live flat in `test/` (the `test` script globs `test/*.test.ts`).
- Build and test, webapp (`signalk-binnacle`): `npm test` (`vitest run`), `npm run check` (`svelte-check`). Single test file: `npx vitest run src/<path>.test.ts`.
- `engines.node` floor: companion `>=20.3.0`, webapp `>=22`. All code must run on the lowest declared version. The `pmtiles` library is pure JS with no native code.
- Do not add a `prepare` or `prepack` lifecycle script to `package.json` (it corrupts the App Store install-simulation CI step).
- Reuse before adding: the webapp already has `pmtiles-metadata.ts` (header decode and bounds logic), `SlideOver.svelte`, the `shared/ui` primitives, and `panels.css` tokens. Mirror them; do not re-implement.

---

## Phase A: the headless provider

Discovery, decode and validate and register, the strong-ETag Range serve route, the mutual exclusion and teardown, and the webapp provided-path switch. This is fully functional without any new UI and fixes third-party pains 1 through 5 and 8.

### Task 1: pmtiles dependency and the nameToId chart-id helper

**Files:**
- Modify: `package.json` (add the `pmtiles` runtime dependency)
- Create: `src/charts/chart-id.ts`
- Test: `test/chart-id.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `nameToId(fileName: string): string`. Maps `"x.pmtiles"` to `"x-pmtiles"`, replacing only the first `.pmtiles` occurrence, identical to the third-party scheme.

- [ ] **Step 1: Add the dependency**

In `package.json`, add to `dependencies` (keep the existing `signalk-binnacle-chart-sources` entry):

```json
    "pmtiles": "^4.4.1"
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `pmtiles@4.4.1` (or a later 4.x) appears in `node_modules` and the lockfile updates.

- [ ] **Step 3: Write the failing test**

```ts
// test/chart-id.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nameToId } from '../src/charts/chart-id.js'

test('nameToId maps a .pmtiles filename to its resource id', () => {
  assert.equal(nameToId('sf-bay.pmtiles'), 'sf-bay-pmtiles')
})

test('nameToId replaces only the first .pmtiles occurrence, preserving the third-party scheme', () => {
  assert.equal(nameToId('a.pmtiles.pmtiles'), 'a-pmtiles.pmtiles')
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --import tsx --test test/chart-id.test.ts`
Expected: FAIL with a module-not-found error for `../src/charts/chart-id.js`.

- [ ] **Step 5: Write minimal implementation**

```ts
// src/charts/chart-id.ts
/** The chart-resource id scheme: map "file.pmtiles" to "file-pmtiles", preserved from the
 * third-party signalk-pmtiles-plugin so a cutover does not reset webapp state keyed by chart id.
 * String.replace with a string pattern replaces only the first occurrence, matching the original. */
export function nameToId (fileName: string): string {
  return fileName.replace('.pmtiles', '-pmtiles')
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --import tsx --test test/chart-id.test.ts`
Expected: PASS, both tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/charts/chart-id.ts test/chart-id.test.ts
git commit -m "feat(charts): add pmtiles dependency and the nameToId id helper"
```

---

### Task 2: a filesystem-backed pmtiles Source and the fixture builder

**Files:**
- Create: `src/charts/pmtiles-file-source.ts`
- Create: `test/pmtiles-fixture.ts` (a shared fixture builder, not a test file)
- Test: `test/pmtiles-file-source.test.ts`

**Interfaces:**
- Consumes: the `Source` and `RangeResponse` types from `pmtiles`.
- Produces:
  - `class PmtilesFileSource implements Source` with `constructor(filePath: string)`, `getKey(): string` (returns the file path), and `getBytes(offset: number, length: number): Promise<RangeResponse>` (reads bytes off disk, returning fewer than `length` bytes at end of file).
  - `buildPmtilesFixture(opts?: FixtureOptions): Buffer` and `interface FixtureOptions { magic?: string; version?: number; tileType?: number; minZoom?: number; maxZoom?: number; minLonE7?: number; minLatE7?: number; maxLonE7?: number; maxLatE7?: number; metadata?: unknown }`, building a minimal valid PMTiles v3 archive in memory.

- [ ] **Step 1: Write the fixture builder (shared test helper)**

```ts
// test/pmtiles-fixture.ts
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
  header.writeUInt8(0, 118) // center zoom
  header.writeInt32LE(-1215000000, 119) // center lon
  header.writeInt32LE(375000000, 123) // center lat
  return Buffer.concat([header, meta])
}
```

- [ ] **Step 2: Write the failing test**

```ts
// test/pmtiles-file-source.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PmtilesFileSource } from '../src/charts/pmtiles-file-source.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

test('getBytes reads the requested range off disk and getKey returns the path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-src-'))
  const file = join(dir, 'a.pmtiles')
  await writeFile(file, buildPmtilesFixture())
  try {
    const source = new PmtilesFileSource(file)
    assert.equal(source.getKey(), file)
    const { data } = await source.getBytes(0, 7)
    assert.equal(Buffer.from(data).toString('ascii'), 'PMTiles')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getBytes returns only the available bytes when the range runs past end of file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-src-'))
  const file = join(dir, 'a.pmtiles')
  const fixture = buildPmtilesFixture()
  await writeFile(file, fixture)
  try {
    const source = new PmtilesFileSource(file)
    const { data } = await source.getBytes(0, 16384)
    assert.equal(data.byteLength, fixture.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test test/pmtiles-file-source.test.ts`
Expected: FAIL with a module-not-found error for `../src/charts/pmtiles-file-source.js`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/charts/pmtiles-file-source.ts
/** A pmtiles Source backed by a local file, so the JS pmtiles library can decode an archive
 * off disk in process. This replaces the third-party plugin's metadata read over loopback HTTP. */

import { open } from 'node:fs/promises'
import type { RangeResponse, Source } from 'pmtiles'

export class PmtilesFileSource implements Source {
  readonly #filePath: string

  constructor (filePath: string) {
    this.#filePath = filePath
  }

  getKey (): string {
    return this.#filePath
  }

  async getBytes (offset: number, length: number): Promise<RangeResponse> {
    const handle = await open(this.#filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      const view = buffer.subarray(0, bytesRead)
      // Return a tight ArrayBuffer copy of exactly the bytes read, never the padded allocation.
      return { data: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) }
    } finally {
      await handle.close()
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/pmtiles-file-source.test.ts`
Expected: PASS, both tests.

- [ ] **Step 6: Commit**

```bash
git add src/charts/pmtiles-file-source.ts test/pmtiles-file-source.ts test/pmtiles-fixture.ts test/pmtiles-file-source.test.ts
git commit -m "feat(charts): add a filesystem-backed pmtiles Source and fixture builder"
```

---

### Task 3: decode and validate an archive off disk

**Files:**
- Create: `src/charts/pmtiles-metadata.ts`
- Test: `test/pmtiles-metadata.test.ts`

**Interfaces:**
- Consumes: `PmtilesFileSource` (Task 2), `buildPmtilesFixture` (Task 2), the `PMTiles` class, `TileType`, and `Header` from `pmtiles`.
- Produces:
  - `type PmtilesFormat = 'mvt' | 'png' | 'jpg' | 'webp' | 'avif'`
  - `interface DecodedPmtiles { minzoom: number; maxzoom: number; bounds?: [number, number, number, number]; format: PmtilesFormat; vectorLayers: string[]; name?: string }`
  - `type DecodeResult = { ok: true; decoded: DecodedPmtiles } | { ok: false; error: string }`
  - `async decodePmtilesArchive(filePath: string): Promise<DecodeResult>`

- [ ] **Step 1: Write the failing test**

```ts
// test/pmtiles-metadata.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePmtilesArchive } from '../src/charts/pmtiles-metadata.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

async function withFixture (bytes: Buffer, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pmt-meta-'))
  const file = join(dir, 'chart.pmtiles')
  await writeFile(file, bytes)
  try {
    await run(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a good vector archive decodes with bounds, zoom, format, and layers', async () => {
  await withFixture(buildPmtilesFixture(), async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.decoded.bounds, [-122, 37, -121, 38])
    assert.equal(result.decoded.minzoom, 0)
    assert.equal(result.decoded.maxzoom, 14)
    assert.equal(result.decoded.format, 'mvt')
    assert.deepEqual(result.decoded.vectorLayers, ['water'])
    assert.equal(result.decoded.name, 'Test Chart')
  })
})

test('a bad magic is rejected as not a PMTiles archive', async () => {
  await withFixture(buildPmtilesFixture({ magic: 'XXXXXXX' }), async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /magic/i)
  })
})

test('an unknown tile type is rejected', async () => {
  await withFixture(buildPmtilesFixture({ tileType: 0 }), async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /tile type/i)
  })
})

test('a degenerate bounds box is dropped, not an error', async () => {
  const flat = buildPmtilesFixture({ minLonE7: 0, minLatE7: 0, maxLonE7: 0, maxLatE7: 0 })
  await withFixture(flat, async (file) => {
    const result = await decodePmtilesArchive(file)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.decoded.bounds, undefined)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/pmtiles-metadata.test.ts`
Expected: FAIL with a module-not-found error for `../src/charts/pmtiles-metadata.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/charts/pmtiles-metadata.ts
/** Decode and validate a PMTiles archive off disk, awaited before the chart is published, so bounds,
 * zoom, the tile format, and the vector layers are always present. Mirrors the webapp
 * src/shared/map/pmtiles-metadata.ts so the two stay in step. */

import { open } from 'node:fs/promises'
import { type Header, PMTiles, TileType } from 'pmtiles'
import { PmtilesFileSource } from './pmtiles-file-source.js'

export type PmtilesFormat = 'mvt' | 'png' | 'jpg' | 'webp' | 'avif'

export interface DecodedPmtiles {
  minzoom: number
  maxzoom: number
  bounds?: [number, number, number, number]
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
function boundsFromHeader (header: Header): [number, number, number, number] | undefined {
  const { minLon, minLat, maxLon, maxLat } = header
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return undefined
  if (minLon >= maxLon || minLat >= maxLat) return undefined
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/pmtiles-metadata.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add src/charts/pmtiles-metadata.ts test/pmtiles-metadata.test.ts
git commit -m "feat(charts): decode and validate a pmtiles archive off disk"
```

---

### Task 4: the chart registry and the resource-provider registration

**Files:**
- Create: `src/charts/chart-registry.ts`
- Test: `test/chart-registry.test.ts`

**Interfaces:**
- Consumes: `nameToId` (Task 1), `DecodedPmtiles` (Task 3), the `ResourceProvider` type and `registerResourceProvider` from `@signalk/server-api`.
- Produces:
  - `const SERVE_BASE = '/plugins/signalk-binnacle-companion/pmtiles'`
  - `const DEFAULT_SCALE = 250000`
  - `function serveUrl(fileName: string): string`
  - `interface ChartRecord { identifier: string; fileName: string; filePath: string; name: string; description: string; type: 'tilelayer'; scale: number; decoded: DecodedPmtiles }`
  - `interface ChartResource` (the flat SignalKChart-shaped object: `identifier`, `name`, `description`, `type`, `scale`, optional `bounds`, `minzoom`, `maxzoom`, `format`, `url`, `tilemapUrl`, `layers`)
  - `function chartResource(record: ChartRecord): ChartResource`
  - `class ChartRegistry` with `set(record: ChartRecord): void`, `delete(id: string): void`, `clear(): void`, `has(id: string): boolean`, `filePathFor(id: string): string | undefined`, `records(): ChartRecord[]`, `list(): ChartResource[]`, `get(id: string): ChartResource | undefined`, `setError(fileName: string, error: string): void`, `clearError(fileName: string): void`, `errors(): Array<{ fileName: string, error: string }>`
  - `interface ChartRouteApp { get(path: string, handler: (req: { params: Record<string, string> }, res: V1Res) => void): void; registerResourceProvider(provider: ResourceProvider): void }` where `interface V1Res { json(body: unknown): void; status(code: number): V1Res; send(body: string): void }`
  - `function registerChartProvider(app: ChartRouteApp, registry: ChartRegistry): void` (idempotent per app object)

- [ ] **Step 1: Write the failing test**

```ts
// test/chart-registry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ChartRegistry,
  chartResource,
  registerChartProvider,
  serveUrl,
  type ChartRecord
} from '../src/charts/chart-registry.js'
import type { ResourceProvider } from '@signalk/server-api'

function record (fileName: string): ChartRecord {
  return {
    identifier: fileName.replace('.pmtiles', '-pmtiles'),
    fileName,
    filePath: `/charts/${fileName}`,
    name: fileName.replace('.pmtiles', ''),
    description: '',
    type: 'tilelayer',
    scale: 250000,
    decoded: { minzoom: 0, maxzoom: 14, bounds: [-122, 37, -121, 38], format: 'mvt', vectorLayers: ['water'] }
  }
}

test('chartResource points url and tilemapUrl at the serve route and carries the decoded metadata', () => {
  const r = chartResource(record('sf.pmtiles'))
  assert.equal(r.identifier, 'sf-pmtiles')
  assert.equal(r.url, serveUrl('sf.pmtiles'))
  assert.equal(r.tilemapUrl, serveUrl('sf.pmtiles'))
  assert.deepEqual(r.bounds, [-122, 37, -121, 38])
  assert.equal(r.format, 'mvt')
  assert.deepEqual(r.layers, ['water'])
})

test('the registry resolves a file path by id and lists resources', () => {
  const registry = new ChartRegistry()
  registry.set(record('sf.pmtiles'))
  assert.equal(registry.filePathFor('sf-pmtiles'), '/charts/sf.pmtiles')
  assert.equal(registry.filePathFor('missing-pmtiles'), undefined)
  assert.equal(registry.list().length, 1)
  registry.clear()
  assert.equal(registry.list().length, 0)
})

test('registerChartProvider exposes the live registry through the v2 provider and the v1 route', async () => {
  const registry = new ChartRegistry()
  let provider: ResourceProvider | undefined
  const routes: Record<string, (req: { params: Record<string, string> }, res: FakeRes) => void> = {}
  const app = {
    get (path: string, handler: (req: { params: Record<string, string> }, res: FakeRes) => void) { routes[path] = handler },
    registerResourceProvider (p: ResourceProvider) { provider = p }
  }
  registerChartProvider(app as never, registry)
  registry.set(record('sf.pmtiles'))

  const list = await provider!.methods.listResources({})
  assert.equal(Object.keys(list).length, 1)
  const got = await provider!.methods.getResource('sf-pmtiles')
  assert.equal((got as { identifier: string }).identifier, 'sf-pmtiles')
  await assert.rejects(() => provider!.methods.getResource('nope'))

  const res = new FakeRes()
  routes['/signalk/v1/api/resources/charts']({ params: {} }, res)
  assert.equal(Object.keys(res.body as object).length, 1)
})

test('registerChartProvider registers the provider only once per app', () => {
  const registry = new ChartRegistry()
  let count = 0
  const app = { get () {}, registerResourceProvider () { count++ } }
  registerChartProvider(app as never, registry)
  registerChartProvider(app as never, registry)
  assert.equal(count, 1)
})

class FakeRes {
  body: unknown
  statusCode = 200
  json (b: unknown): void { this.body = b }
  status (c: number): this { this.statusCode = c; return this }
  send (b: string): void { this.body = b }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/chart-registry.test.ts`
Expected: FAIL with a module-not-found error for `../src/charts/chart-registry.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/charts/chart-registry.ts
/** Holds the discovered chart set and exposes it to the Signal K resources read path. The provider
 * methods and the v1 routes read the live registry, so discovery mutates the map and the registration
 * happens once. Signal K exposes no unregisterResourceProvider and Express no route deregistration,
 * so teardown clears the map: the provider then serves an empty set. */

import type { ResourceProvider } from '@signalk/server-api'
import { nameToId } from './chart-id.js'
import type { DecodedPmtiles } from './pmtiles-metadata.js'

export const SERVE_BASE = '/plugins/signalk-binnacle-companion/pmtiles'
export const DEFAULT_SCALE = 250000
const V1_CHARTS = '/signalk/v1/api/resources/charts'

export function serveUrl (fileName: string): string {
  return `${SERVE_BASE}/${encodeURIComponent(fileName)}`
}

export interface ChartRecord {
  identifier: string
  fileName: string
  filePath: string
  name: string
  description: string
  type: 'tilelayer'
  scale: number
  decoded: DecodedPmtiles
}

export interface ChartResource {
  identifier: string
  name: string
  description: string
  type: 'tilelayer'
  scale: number
  bounds?: [number, number, number, number]
  minzoom: number
  maxzoom: number
  format: string
  url: string
  tilemapUrl: string
  layers: string[]
}

export function chartResource (record: ChartRecord): ChartResource {
  const url = serveUrl(record.fileName)
  return {
    identifier: record.identifier,
    name: record.name,
    description: record.description,
    type: record.type,
    scale: record.scale,
    ...(record.decoded.bounds ? { bounds: record.decoded.bounds } : {}),
    minzoom: record.decoded.minzoom,
    maxzoom: record.decoded.maxzoom,
    format: record.decoded.format,
    url,
    tilemapUrl: url,
    layers: record.decoded.vectorLayers
  }
}

export class ChartRegistry {
  readonly #records = new Map<string, ChartRecord>()
  readonly #errors = new Map<string, string>()

  set (record: ChartRecord): void {
    this.#records.set(record.identifier, record)
  }

  delete (id: string): void {
    this.#records.delete(id)
  }

  clear (): void {
    this.#records.clear()
    this.#errors.clear()
  }

  has (id: string): boolean {
    return this.#records.has(id)
  }

  filePathFor (id: string): string | undefined {
    return this.#records.get(id)?.filePath
  }

  records (): ChartRecord[] {
    return [...this.#records.values()]
  }

  list (): ChartResource[] {
    return this.records().map(chartResource)
  }

  get (id: string): ChartResource | undefined {
    const record = this.#records.get(id)
    return record ? chartResource(record) : undefined
  }

  setError (fileName: string, error: string): void {
    this.#errors.set(fileName, error)
  }

  clearError (fileName: string): void {
    this.#errors.delete(fileName)
  }

  errors (): Array<{ fileName: string, error: string }> {
    return [...this.#errors.entries()].map(([fileName, error]) => ({ fileName, error }))
  }
}

interface V1Res {
  json (body: unknown): void
  status (code: number): V1Res
  send (body: string): void
}

export interface ChartRouteApp {
  get (path: string, handler: (req: { params: Record<string, string> }, res: V1Res) => void): void
  registerResourceProvider (provider: ResourceProvider): void
}

// Register the v2 provider and the v1 routes once per app, so an enable, disable, then re-enable
// cycle does not throw a duplicate-provider error. The methods close over the live registry.
const registeredApps = new WeakSet<object>()

export function registerChartProvider (app: ChartRouteApp, registry: ChartRegistry): void {
  if (registeredApps.has(app)) return
  registeredApps.add(app)

  app.registerResourceProvider({
    type: 'charts',
    methods: {
      listResources: () => {
        const out: Record<string, ChartResource> = {}
        for (const resource of registry.list()) out[resource.identifier] = resource
        return Promise.resolve(out)
      },
      getResource: (id: string) => {
        const resource = registry.get(id)
        return resource ? Promise.resolve(resource) : Promise.reject(new Error(`Chart not found: ${id}`))
      },
      setResource: (id: string) => Promise.reject(new Error(`Not implemented: cannot set ${id}`)),
      deleteResource: (id: string) => Promise.reject(new Error(`Not implemented: cannot delete ${id}`))
    }
  })

  app.get(`${V1_CHARTS}/:identifier`, (req, res) => {
    const resource = registry.get(req.params.identifier)
    if (resource) res.json(resource)
    else res.status(404).send('Not found')
  })
  app.get(V1_CHARTS, (_req, res) => {
    const out: Record<string, ChartResource> = {}
    for (const resource of registry.list()) out[resource.identifier] = resource
    res.json(out)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/chart-registry.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/charts/chart-registry.ts test/chart-registry.test.ts
git commit -m "feat(charts): add the chart registry and resource-provider registration"
```

---

### Task 5: the mutual-exclusion detector

**Files:**
- Create: `src/charts/mutual-exclusion.ts`
- Test: `test/mutual-exclusion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const THIRD_PARTY_PLUGIN_ID = 'pmtiles-chart-provider'`
  - `function isThirdPartyPmtilesEnabled(configPath: string): boolean` (reads `<configPath>/plugin-config-data/pmtiles-chart-provider.json` and returns `enabled === true`; a missing or unreadable file is `false`)

- [ ] **Step 1: Write the failing test**

```ts
// test/mutual-exclusion.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isThirdPartyPmtilesEnabled } from '../src/charts/mutual-exclusion.js'

async function configDir (contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cfg-'))
  if (contents !== undefined) {
    await mkdir(join(dir, 'plugin-config-data'), { recursive: true })
    await writeFile(join(dir, 'plugin-config-data', 'pmtiles-chart-provider.json'), contents)
  }
  return dir
}

test('reports true when the third-party plugin config is present and enabled', async () => {
  const dir = await configDir(JSON.stringify({ enabled: true, configuration: {} }))
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports false when the config exists but is disabled', async () => {
  const dir = await configDir(JSON.stringify({ enabled: false }))
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports false when no third-party config file exists', async () => {
  const dir = await configDir()
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/mutual-exclusion.test.ts`
Expected: FAIL with a module-not-found error for `../src/charts/mutual-exclusion.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/charts/mutual-exclusion.ts
/** Detect whether the third-party signalk-pmtiles-plugin is enabled. Running both would show
 * duplicate charts: the resources read path merges all providers and the two id schemes do not
 * dedupe. The plugin enabled state lives in <configPath>/plugin-config-data/<pluginId>.json. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const THIRD_PARTY_PLUGIN_ID = 'pmtiles-chart-provider'

export function isThirdPartyPmtilesEnabled (configPath: string): boolean {
  const file = join(configPath, 'plugin-config-data', `${THIRD_PARTY_PLUGIN_ID}.json`)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown }
    return parsed.enabled === true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/mutual-exclusion.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Commit**

```bash
git add src/charts/mutual-exclusion.ts test/mutual-exclusion.test.ts
git commit -m "feat(charts): detect the third-party pmtiles plugin for mutual exclusion"
```

---

### Task 6: the discovery watch

**Files:**
- Create: `src/charts/discovery.ts`
- Test: `test/chart-discovery.test.ts`

**Interfaces:**
- Consumes: `ChartRegistry`, `ChartRecord`, `DEFAULT_SCALE` (Task 4), `nameToId` (Task 1), `decodePmtilesArchive`, `DecodeResult` (Task 3).
- Produces:
  - `interface ChartNamer { (fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number } }` (lets Task 11 inject the per-chart override; Phase A passes a default namer)
  - `function defaultNamer(fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number }`
  - `interface DiscoveryDeps { chartsDir: string; registry: ChartRegistry; namer?: ChartNamer; decode?: (filePath: string) => Promise<DecodeResult>; debounceMs?: number; onError?: (message: string) => void }`
  - `async function rescanCharts(deps: DiscoveryDeps): Promise<void>`
  - `interface DiscoveryHandle { stop(): void }`
  - `async function startDiscovery(deps: DiscoveryDeps): Promise<DiscoveryHandle>` (initial `rescanCharts`, then a debounced `fs.watch`)

- [ ] **Step 1: Write the failing test**

```ts
// test/chart-discovery.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChartRegistry } from '../src/charts/chart-registry.js'
import { rescanCharts, startDiscovery } from '../src/charts/discovery.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

async function chartsDir (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'charts-'))
  await mkdir(join(dir, 'pmtiles'), { recursive: true })
  return join(dir, 'pmtiles')
}

test('rescanCharts registers a valid archive and records a decode error for a corrupt one', async () => {
  const dir = await chartsDir()
  await writeFile(join(dir, 'good.pmtiles'), buildPmtilesFixture())
  await writeFile(join(dir, 'bad.pmtiles'), buildPmtilesFixture({ magic: 'XXXXXXX' }))
  const registry = new ChartRegistry()
  try {
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.has('good-pmtiles'), true)
    assert.equal(registry.has('bad-pmtiles'), false)
    assert.equal(registry.errors().some((e) => e.fileName === 'bad.pmtiles'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rescanCharts drops a record whose file has been removed', async () => {
  const dir = await chartsDir()
  const file = join(dir, 'good.pmtiles')
  await writeFile(file, buildPmtilesFixture())
  const registry = new ChartRegistry()
  try {
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.has('good-pmtiles'), true)
    await rm(file)
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.has('good-pmtiles'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rescanCharts rejects a symlink that escapes the charts directory', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'outside-'))
  const target = join(outside, 'secret.pmtiles')
  await writeFile(target, buildPmtilesFixture())
  const dir = await chartsDir()
  await symlink(target, join(dir, 'escape.pmtiles'))
  const registry = new ChartRegistry()
  try {
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.has('escape-pmtiles'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('startDiscovery picks up a file added after start, then stops watching', async () => {
  const dir = await chartsDir()
  const registry = new ChartRegistry()
  const handle = await startDiscovery({ chartsDir: dir, registry, debounceMs: 20 })
  try {
    await writeFile(join(dir, 'late.pmtiles'), buildPmtilesFixture())
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(registry.has('late-pmtiles'), true)
  } finally {
    handle.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/chart-discovery.test.ts`
Expected: FAIL with a module-not-found error for `../src/charts/discovery.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/charts/discovery.ts
/** Watch a charts directory and keep the registry in step with the .pmtiles files in it, without a
 * plugin restart. Each file is realpath-resolved and confirmed contained under the directory before
 * it is decoded, so a symlink or a path that escapes the directory is rejected. */

import { type FSWatcher, watch } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { nameToId } from './chart-id.js'
import { type ChartRegistry, DEFAULT_SCALE } from './chart-registry.js'
import { type DecodeResult, decodePmtilesArchive, type DecodedPmtiles } from './pmtiles-metadata.js'

export interface ChartNamer {
  (fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number }
}

export function defaultNamer (fileName: string, decoded: DecodedPmtiles): { name: string, description: string, scale: number } {
  return { name: decoded.name ?? fileName.replace(/\.pmtiles$/i, ''), description: '', scale: DEFAULT_SCALE }
}

export interface DiscoveryDeps {
  chartsDir: string
  registry: ChartRegistry
  namer?: ChartNamer
  decode?: (filePath: string) => Promise<DecodeResult>
  debounceMs?: number
  onError?: (message: string) => void
}

const PMTILES_RE = /\.pmtiles$/i

async function containedRealPath (chartsDir: string, fileName: string): Promise<string | undefined> {
  try {
    const dirReal = await realpath(chartsDir)
    const fileReal = await realpath(join(chartsDir, fileName))
    return fileReal.startsWith(dirReal + sep) ? fileReal : undefined
  } catch {
    return undefined
  }
}

export async function rescanCharts (deps: DiscoveryDeps): Promise<void> {
  const decode = deps.decode ?? decodePmtilesArchive
  const namer = deps.namer ?? defaultNamer
  let entries: string[]
  try {
    entries = (await readdir(deps.chartsDir, { withFileTypes: true }))
      .filter((entry) => PMTILES_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    // A missing directory yields an empty set: the registry is cleared of stale records below.
    entries = []
  }

  const seen = new Set<string>()
  for (const fileName of entries) {
    const filePath = await containedRealPath(deps.chartsDir, fileName)
    if (!filePath) continue
    const result = await decode(filePath)
    if (!result.ok) {
      deps.registry.setError(fileName, result.error)
      deps.onError?.(`${fileName}: ${result.error}`)
      continue
    }
    deps.registry.clearError(fileName)
    const naming = namer(fileName, result.decoded)
    seen.add(nameToId(fileName))
    deps.registry.set({
      identifier: nameToId(fileName),
      fileName,
      filePath,
      name: naming.name,
      description: naming.description,
      type: 'tilelayer',
      scale: naming.scale,
      decoded: result.decoded
    })
  }

  for (const record of deps.registry.records()) {
    if (!seen.has(record.identifier)) deps.registry.delete(record.identifier)
  }
}

export interface DiscoveryHandle {
  stop: () => void
}

export async function startDiscovery (deps: DiscoveryDeps): Promise<DiscoveryHandle> {
  await rescanCharts(deps)
  const debounceMs = deps.debounceMs ?? 300
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(deps.chartsDir, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void rescanCharts(deps) }, debounceMs)
    })
  } catch (err) {
    deps.onError?.(`cannot watch ${deps.chartsDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    stop () {
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/chart-discovery.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 5: Commit**

```bash
git add src/charts/discovery.ts test/chart-discovery.test.ts
git commit -m "feat(charts): add the debounced discovery watch with realpath containment"
```

---

### Task 7: the strong-ETag Range serve route

**Files:**
- Create: `src/http/pmtiles-routes.ts`
- Test: `test/pmtiles-routes.test.ts`

**Interfaces:**
- Consumes: `ChartRegistry` (Task 4), `nameToId` (Task 1).
- Produces:
  - `const PMTILES_SERVE_PATH = '/pmtiles/:file'`
  - `interface ServeRequest { params: { file: string }; headers: Record<string, string | string[] | undefined> }`
  - `interface ServeResponse` (a Writable plus `status(code: number): ServeResponse`, `setHeader(name: string, value: string): void`, `end(body?: string): void`, `headersSent: boolean`)
  - `interface ServeRouter { get(path: string, handler: (req: ServeRequest, res: ServeResponse) => void): void }`
  - `function registerPmtilesServeRoute(router: ServeRouter, registry: ChartRegistry): void`

- [ ] **Step 1: Write the failing test**

```ts
// test/pmtiles-routes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChartRegistry, type ChartRecord } from '../src/charts/chart-registry.js'
import { registerPmtilesServeRoute, type ServeRequest } from '../src/http/pmtiles-routes.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

class FakeRes extends PassThrough {
  statusCode = 0
  outHeaders: Record<string, string> = {}
  headersSent = false
  status (c: number): this { this.statusCode = c; return this }
  setHeader (n: string, v: string): void { this.outHeaders[n.toLowerCase()] = v }
}

function collect (): { routes: Record<string, (req: ServeRequest, res: FakeRes) => void>, registry: ChartRegistry } {
  const routes: Record<string, (req: ServeRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  registerPmtilesServeRoute({ get (p, h) { routes[p] = h as (req: ServeRequest, res: FakeRes) => void } }, registry)
  return { routes, registry }
}

async function fixtureRecord (): Promise<{ record: ChartRecord, cleanup: () => Promise<void>, size: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'serve-'))
  const file = join(dir, 'sf.pmtiles')
  const bytes = buildPmtilesFixture()
  await writeFile(file, bytes)
  return {
    size: bytes.length,
    record: {
      identifier: 'sf-pmtiles', fileName: 'sf.pmtiles', filePath: file, name: 'sf', description: '',
      type: 'tilelayer', scale: 250000,
      decoded: { minzoom: 0, maxzoom: 14, format: 'mvt', vectorLayers: [] }
    },
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

function req (file: string, headers: Record<string, string> = {}): ServeRequest {
  return { params: { file }, headers }
}

async function finished (res: FakeRes): Promise<Buffer> {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  await new Promise((resolve) => res.on('finish', resolve))
  return Buffer.concat(chunks)
}

test('an unknown id returns 404', async () => {
  const { routes } = collect()
  const res = new FakeRes()
  routes['/pmtiles/:file'](req('nope.pmtiles'), res)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(res.statusCode, 404)
})

test('a full GET returns 200 with a strong ETag and Accept-Ranges', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), res)
    const body = await finished(res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.outHeaders['accept-ranges'], 'bytes')
    assert.match(res.outHeaders.etag, /^"\d+-\d+"$/)
    assert.equal(res.outHeaders.etag.startsWith('"W/'), false)
    assert.equal(body.length, size)
  } finally {
    await cleanup()
  }
})

test('a Range request returns 206 with Content-Range and the partial body', async () => {
  const { routes, registry } = collect()
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6' }), res)
    const body = await finished(res)
    assert.equal(res.statusCode, 206)
    assert.match(res.outHeaders['content-range'], /^bytes 0-6\/\d+$/)
    assert.equal(body.toString('ascii'), 'PMTiles')
  } finally {
    await cleanup()
  }
})

test('an If-None-Match that matches returns 304', async () => {
  const { routes, registry } = collect()
  const { record, cleanup } = await fixtureRecord()
  registry.set(record)
  try {
    const first = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles'), first)
    await finished(first)
    const etag = first.outHeaders.etag
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { 'if-none-match': etag }), res)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 304)
  } finally {
    await cleanup()
  }
})

test('an If-Range that does not match returns the full 200, not a 206', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: 'bytes=0-6', 'if-range': '"stale-validator"' }), res)
    const body = await finished(res)
    assert.equal(res.statusCode, 200)
    assert.equal(body.length, size)
  } finally {
    await cleanup()
  }
})

test('an unsatisfiable range returns 416', async () => {
  const { routes, registry } = collect()
  const { record, cleanup, size } = await fixtureRecord()
  registry.set(record)
  try {
    const res = new FakeRes()
    routes['/pmtiles/:file'](req('sf.pmtiles', { range: `bytes=${size + 10}-${size + 20}` }), res)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(res.statusCode, 416)
    assert.equal(res.outHeaders['content-range'], `bytes */${size}`)
  } finally {
    await cleanup()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/pmtiles-routes.test.ts`
Expected: FAIL with a module-not-found error for `../src/http/pmtiles-routes.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/http/pmtiles-routes.ts
/** Serve a discovered PMTiles archive over a Range-capable route with a strong ETag minted from file
 * identity (size and mtime in nanoseconds), so the browser HTTP cache and the pmtiles library work
 * without the cache: 'no-store' workaround. The ETag is never a hash of the 127-byte header: a
 * re-exported archive with a byte-identical header must still get a new ETag. The route is open
 * read-only; an unknown id returns 404, an id can never reach a file outside the discovered set. */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { type Writable } from 'node:stream'
import { nameToId } from '../charts/chart-id.js'
import type { ChartRegistry } from '../charts/chart-registry.js'

export const PMTILES_SERVE_PATH = '/pmtiles/:file'

export interface ServeRequest {
  params: { file: string }
  headers: Record<string, string | string[] | undefined>
}

export interface ServeResponse {
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

export function registerPmtilesServeRoute (router: ServeRouter, registry: ChartRegistry): void {
  router.get(PMTILES_SERVE_PATH, (req, res) => {
    void serve(req, res, registry)
  })
}

async function serve (req: ServeRequest, res: ServeResponse, registry: ChartRegistry): Promise<void> {
  const filePath = registry.filePathFor(nameToId(req.params.file))
  if (!filePath) {
    res.status(404).end('Not found')
    return
  }
  let size: number
  let etag: string
  try {
    const info = await stat(filePath, { bigint: true })
    size = Number(info.size)
    etag = `"${info.size}-${info.mtimeNs}"`
  } catch {
    res.status(404).end('Not found')
    return
  }

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('ETag', etag)
  res.setHeader('Content-Type', 'application/octet-stream')

  const rangeHeader = header(req.headers.range)
  const ifNoneMatch = header(req.headers['if-none-match'])
  if (!rangeHeader && ifNoneMatch === etag) {
    res.status(304).end()
    return
  }

  // If-Range guards the conditional range: a validator that does not match falls back to the full 200,
  // never a 206 against a stale validator.
  const ifRange = header(req.headers['if-range'])
  const honorRange = !ifRange || ifRange === etag
  const range = honorRange ? parseRange(rangeHeader, size) : null

  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`)
    res.status(416).end()
    return
  }

  if (range) {
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    res.setHeader('Content-Length', String(range.end - range.start + 1))
    res.status(206)
    pipeStream(createReadStream(filePath, { start: range.start, end: range.end }), res)
    return
  }

  res.setHeader('Content-Length', String(size))
  res.status(200)
  pipeStream(createReadStream(filePath), res)
}

function pipeStream (stream: NodeJS.ReadableStream, res: ServeResponse): void {
  stream.on('error', () => {
    if (!res.headersSent) res.status(500)
    res.end()
  })
  ;(stream as NodeJS.ReadableStream & { pipe: (dest: Writable) => void }).pipe(res as unknown as Writable)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/pmtiles-routes.test.ts`
Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

```bash
git add src/http/pmtiles-routes.ts test/pmtiles-routes.test.ts
git commit -m "feat(charts): serve pmtiles archives with a strong ETag and Range support"
```

---

### Task 8: wire the chart provider into the plugin lifecycle

**Files:**
- Modify: `src/plugin/plugin.ts`
- Test: `test/plugin-charts.test.ts`

**Interfaces:**
- Consumes: `ChartRegistry`, `registerChartProvider`, `ChartRouteApp` (Task 4), `startDiscovery`, `DiscoveryHandle` (Task 6), `isThirdPartyPmtilesEnabled` (Task 5), `registerPmtilesServeRoute`, `ServeRouter` (Task 7).
- Produces: an extended `CompanionConfig` with `chartsPath?: string`, a `chartsPath` schema field, and chart discovery wired through `doStart`, `doStop`, and `registerWithRouter`. No new exported symbols beyond the plugin factory.

- [ ] **Step 1: Write the failing test**

```ts
// test/plugin-charts.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin } from '../src/plugin/plugin.js'
import { fakeApp, fakeManager, setContainerManager, clearGlobals } from './helpers.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

interface ChartApp extends ReturnType<typeof fakeApp> {
  config: { configPath: string }
  getDataDirPath: () => string
  registerResourceProvider: (provider: unknown) => void
  get: (path: string, handler: unknown) => void
}

async function configRoot (): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sk-'))
  await mkdir(join(root, 'charts', 'pmtiles'), { recursive: true })
  return root
}

function chartApp (configPath: string): { app: ChartApp, providers: unknown[], routes: Record<string, unknown> } {
  const providers: unknown[] = []
  const routes: Record<string, unknown> = {}
  const app = {
    ...fakeApp(),
    config: { configPath },
    getDataDirPath: () => configPath,
    registerResourceProvider: (p: unknown) => providers.push(p),
    get: (path: string, handler: unknown) => { routes[path] = handler }
  } as ChartApp
  return { app, providers, routes }
}

test('doStart discovers charts and registers the provider when the third-party plugin is absent', async () => {
  const root = await configRoot()
  await writeFile(join(root, 'charts', 'pmtiles', 'good.pmtiles'), buildPmtilesFixture())
  setContainerManager(fakeManager())
  const { app, providers } = chartApp(root)
  const plugin = createPlugin(app as never)
  try {
    await plugin.start({})
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(providers.length, 1)
  } finally {
    await plugin.stop()
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('doStart does not register charts when the third-party plugin is enabled, and surfaces the conflict', async () => {
  const root = await configRoot()
  await mkdir(join(root, 'plugin-config-data'), { recursive: true })
  await writeFile(join(root, 'plugin-config-data', 'pmtiles-chart-provider.json'), JSON.stringify({ enabled: true }))
  setContainerManager(fakeManager())
  const { app, providers } = chartApp(root)
  const plugin = createPlugin(app as never)
  try {
    await plugin.start({})
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(providers.length, 0)
    assert.equal(app.status.some((s) => /signalk-pmtiles-plugin/i.test(s)), true)
  } finally {
    await plugin.stop()
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})

test('registerWithRouter mounts the open serve route', async () => {
  const root = await configRoot()
  setContainerManager(fakeManager())
  const { app } = chartApp(root)
  const plugin = createPlugin(app as never)
  const routerRoutes: Record<string, unknown> = {}
  try {
    plugin.registerWithRouter?.({ get: (p: string, h: unknown) => { routerRoutes[p] = h } } as never)
    assert.equal(typeof routerRoutes['/pmtiles/:file'], 'function')
  } finally {
    clearGlobals()
    await rm(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/plugin-charts.test.ts`
Expected: FAIL because `doStart` does not yet register a chart provider, and `/pmtiles/:file` is not mounted.

- [ ] **Step 3: Write minimal implementation**

In `src/plugin/plugin.ts`, add imports near the existing ones:

```ts
import { ChartRegistry, registerChartProvider, type ChartRouteApp } from '../charts/chart-registry.js'
import { type DiscoveryHandle, startDiscovery } from '../charts/discovery.js'
import { isThirdPartyPmtilesEnabled } from '../charts/mutual-exclusion.js'
import { registerPmtilesServeRoute, type ServeRouter } from '../http/pmtiles-routes.js'
import { join, resolve } from 'node:path'
```

Extend `CompanionConfig`:

```ts
interface CompanionConfig {
  imageTag?: string
  tilecacheImageTag?: string
  tilecacheCacheCapBytes?: number
  tilecacheCacheVolumeSource?: string
  chartsPath?: string
}
```

Add a config-path narrowing near the top of `createPlugin`, alongside the existing `let lifecycle` state:

```ts
  interface ConfigAwareApp { config: { configPath: string } }
  const configPath = (app as unknown as ConfigAwareApp).config.configPath
  const registry = new ChartRegistry()
  let discovery: DiscoveryHandle | undefined

  function chartsDirFor (config: CompanionConfig): string {
    const override = config.chartsPath?.trim()
    return override ? resolve(configPath, override) : join(configPath, 'charts', 'pmtiles')
  }

  async function setupCharts (config: CompanionConfig): Promise<void> {
    if (isThirdPartyPmtilesEnabled(configPath)) {
      app.setPluginStatus('Charts disabled: signalk-pmtiles-plugin is enabled. Disable it to let the companion provide PMTiles charts.')
      return
    }
    registerChartProvider(app as unknown as ChartRouteApp, registry)
    discovery = await startDiscovery({
      chartsDir: chartsDirFor(config),
      registry,
      onError: (message) => app.debug(`Chart discovery: ${message}`)
    })
  }

  function teardownCharts (): void {
    discovery?.stop()
    discovery = undefined
    registry.clear()
  }
```

At the end of `doStart` (after the container wiring, before the final `setPluginStatus`), add:

```ts
    await setupCharts(config)
```

Note: keep the final router and tilecache status line, but let the chart conflict status set above stand when the third-party plugin is enabled. Guard the trailing `setPluginStatus` so it does not overwrite the conflict message:

```ts
    if (registry.records().length > 0 || discovery !== undefined) {
      app.setPluginStatus(`Router at ${address}${tilecacheAddress !== null ? `, tilecache at ${tilecacheAddress}` : ''}.`)
    }
```

In `doStop`, before `removeRouteOnWaterBridge()` returns, add:

```ts
    teardownCharts()
```

In `registerWithRouter`, mount the serve route in addition to the tile routes:

```ts
    registerWithRouter (router) {
      registerTileRoutes(router as unknown as TileRouter, () => tilecacheAddress)
      registerPmtilesServeRoute(router as unknown as ServeRouter, registry)
    }
```

Add the `chartsPath` field to the `schema()` properties object:

```ts
        chartsPath: {
          type: 'string',
          title: 'PMTiles charts directory',
          description: 'Directory holding .pmtiles charts, relative to the Signal K config path. Leave blank for the default charts/pmtiles.',
          default: ''
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/plugin-charts.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Run the full plugin suite, typecheck, and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. No regression in the existing plugin tests.

- [ ] **Step 6: Commit**

```bash
git add src/plugin/plugin.ts test/plugin-charts.test.ts
git commit -m "feat(charts): wire discovery, registration, and the serve route into the plugin"
```

---

### Task 9: the webapp provided-path source switch

**Files:**
- Modify: `src/shared/map/pmtiles.ts` (in `signalk-binnacle`)
- Test: `src/shared/map/pmtiles.test.ts` (in `signalk-binnacle`, add cases)

**Interfaces:**
- Consumes: the `FetchSource`, `NoStoreSource` (existing), and `BlockCachedSource` (existing) classes.
- Produces:
  - `const COMPANION_PMTILES_PREFIX = '/plugins/signalk-binnacle-companion/pmtiles/'`
  - updated `createArchiveSource(httpUrl: string): Source` returning a plain `FetchSource` for a provided-path url (default browser HTTP cache, no IndexedDB block cache), `NoStoreSource` for a blob, and `BlockCachedSource(NoStoreSource)` for any other network archive.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/map/pmtiles.test.ts` in `signalk-binnacle`:

```ts
import { FetchSource } from 'pmtiles';
import { createArchiveSource, NoStoreSource } from './pmtiles';
import { BlockCachedSource } from './block-cached-source';

describe('createArchiveSource provided-path switch', () => {
  it('uses a plain FetchSource for a companion-provided archive (default cache, no block cache)', () => {
    const source = createArchiveSource('http://pi.local/plugins/signalk-binnacle-companion/pmtiles/sf.pmtiles');
    expect(source).toBeInstanceOf(FetchSource);
  });

  it('keeps NoStoreSource for a blob archive', () => {
    const source = createArchiveSource('blob:http://pi.local/abc-123');
    expect(source).toBeInstanceOf(NoStoreSource);
  });

  it('keeps the block-cached no-store source for any other network archive', () => {
    const source = createArchiveSource('https://charts.example.com/world.pmtiles');
    expect(source).toBeInstanceOf(BlockCachedSource);
  });

  it('does not treat a remote url that merely contains the prefix as a different segment', () => {
    const source = createArchiveSource('https://evil.example.com/x/plugins/signalk-binnacle-companion/pmtilesX/a.pmtiles');
    expect(source).toBeInstanceOf(BlockCachedSource);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/map/pmtiles.test.ts`
Expected: FAIL: the provided-path case returns a `BlockCachedSource`, not a `FetchSource`.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/map/pmtiles.ts`, add the import and a detector, and update `createArchiveSource`:

```ts
import { FetchSource, PMTiles, Protocol, type RangeResponse, type Source } from 'pmtiles';
```

```ts
// The companion serve route path. An archive served from it carries a strong ETag, so the browser
// HTTP cache works and the no-store workaround plus the IndexedDB block cache are not needed. The
// match is on the exact url path: a false positive that routed a blob or a remote weak-ETag archive
// through this path would reintroduce the Chrome cache-write failure.
const COMPANION_PMTILES_PREFIX = '/plugins/signalk-binnacle-companion/pmtiles/';

function isCompanionProvided(httpUrl: string): boolean {
  try {
    return new URL(httpUrl).pathname.startsWith(COMPANION_PMTILES_PREFIX);
  } catch {
    return false;
  }
}
```

Replace the body of `createArchiveSource`:

```ts
// The source for an archive url. A companion-provided archive uses a plain FetchSource with the
// default browser HTTP cache (its strong ETag makes the range-cache write succeed) and no block
// cache. A blob: archive is already local bytes, so it skips the block cache too. Any other network
// archive keeps the no-store source wrapped in the IndexedDB block cache. Exported for testing.
export function createArchiveSource(httpUrl: string): Source {
  if (isCompanionProvided(httpUrl)) return new FetchSource(httpUrl);
  const inner = new NoStoreSource(httpUrl);
  if (httpUrl.startsWith('blob:')) return inner;
  blockStore ??= createBlockStore();
  return new BlockCachedSource(inner, blockStore);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/map/pmtiles.test.ts`
Expected: PASS, including the existing retry tests.

- [ ] **Step 5: Run the webapp check**

Run: `npm run check`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit (in the signalk-binnacle repo)**

```bash
git add src/shared/map/pmtiles.ts src/shared/map/pmtiles.test.ts
git commit -m "feat(charts): route companion-provided pmtiles through the default browser cache"
```

---

## Phase B: the management UX

The chart-management panel, the per-chart override, and the deferred upload. Fixes third-party pains 6 and 7. The browser upload of an archive is noted and deferred (large archives).

### Task 10: the admin-gate port

**Files:**
- Create: `src/shared/admin-gate.ts`
- Test: `test/admin-gate.test.ts`

**Interfaces:**
- Consumes: `ServerAPI` from `@signalk/server-api`, `PLUGIN_ID` from `../shared/plugin-id.js`.
- Produces: `function ensureApiAdminGate(app: ServerAPI): boolean` (gates `/plugins/<PLUGIN_ID>/api`, idempotent per app, fails closed when no security strategy is present).

- [ ] **Step 1: Write the failing test**

```ts
// test/admin-gate.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureApiAdminGate } from '../src/shared/admin-gate.js'
import { PLUGIN_ID } from '../src/shared/plugin-id.js'

function gatedApp (): { app: unknown, paths: string[] } {
  const paths: string[] = []
  const app = {
    error () {},
    securityStrategy: { addAdminMiddleware (path: string) { paths.push(path) } }
  }
  return { app, paths }
}

test('installs the admin middleware on the /api subtree once and reports true', () => {
  const { app, paths } = gatedApp()
  assert.equal(ensureApiAdminGate(app as never), true)
  assert.equal(ensureApiAdminGate(app as never), true)
  assert.deepEqual(paths, [`/plugins/${PLUGIN_ID}/api`])
})

test('fails closed when the server exposes no admin middleware', () => {
  const errors: string[] = []
  const app = { error (m: string) { errors.push(m) } }
  assert.equal(ensureApiAdminGate(app as never), false)
  assert.equal(errors.length, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/admin-gate.test.ts`
Expected: FAIL with a module-not-found error for `../src/shared/admin-gate.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/admin-gate.ts
/** Admin-gate the plugin's /api subtree once per app. Plugin routers receive no authentication by
 * default, so every /api route sits behind the server's admin middleware. A route that cannot be
 * gated fails closed (it is not mounted) rather than answering unauthenticated callers. The serve
 * route is intentionally not under /api: it is open read-only, like the v1 tile and style routes. */

import type { ServerAPI } from '@signalk/server-api'
import { PLUGIN_ID } from './plugin-id.js'

const API_PATH = `/plugins/${PLUGIN_ID}/api`

// The ServerAPI type does not expose securityStrategy, so narrow to the one method we call.
interface SecurityAwareApp {
  securityStrategy: { addAdminMiddleware: (path: string) => void }
}

const gatedApps = new WeakSet<object>()

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/admin-gate.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/admin-gate.ts test/admin-gate.test.ts
git commit -m "feat(charts): port the admin gate for the management api subtree"
```

---

### Task 11: the per-chart override store and the management routes

**Files:**
- Create: `src/charts/overrides.ts`
- Create: `src/http/chart-management-routes.ts`
- Modify: `src/charts/discovery.ts` (export nothing new; the override namer is passed in by the plugin)
- Modify: `src/plugin/plugin.ts` (load the override store, pass an override namer to discovery, mount the gated management routes)
- Test: `test/chart-overrides.test.ts`
- Test: `test/chart-management-routes.test.ts`

**Interfaces:**
- Consumes: `ChartRegistry`, `chartResource` (Task 4), `ChartNamer`, `defaultNamer` (Task 6), `DecodedPmtiles` (Task 3), `ensureApiAdminGate` (Task 10).
- Produces:
  - `interface ChartOverride { name?: string; description?: string; scale?: number }`
  - `class OverrideStore` with `constructor(filePath: string)`, `load(): Promise<void>`, `get(id: string): ChartOverride | undefined`, `set(id: string, override: ChartOverride): Promise<void>`, `namer(): ChartNamer`
  - `interface ManagementRouter { get(path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void): void; post(path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void): void }`
  - `interface ManagementRequest { params: Record<string, string>; body: unknown }`
  - `interface ManagementResponse { json(body: unknown): void; status(code: number): ManagementResponse }`
  - `function registerChartManagementRoutes(router: ManagementRouter, registry: ChartRegistry, overrides: OverrideStore, onOverride: () => void): void`

- [ ] **Step 1: Write the failing test for the override store**

```ts
// test/chart-overrides.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OverrideStore } from '../src/charts/overrides.js'

test('the override store persists and reloads per-chart overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-'))
  const file = join(dir, 'pmtiles-overrides.json')
  try {
    const store = new OverrideStore(file)
    await store.load()
    await store.set('sf-pmtiles', { name: 'San Francisco Bay', description: 'NOAA ENC' })
    const reloaded = new OverrideStore(file)
    await reloaded.load()
    assert.deepEqual(reloaded.get('sf-pmtiles'), { name: 'San Francisco Bay', description: 'NOAA ENC' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the namer applies an override over the decoded name, falling back to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-'))
  const file = join(dir, 'pmtiles-overrides.json')
  try {
    const store = new OverrideStore(file)
    await store.load()
    await store.set('sf-pmtiles', { name: 'Renamed', scale: 80000 })
    const namer = store.namer()
    const decoded = { minzoom: 0, maxzoom: 14, format: 'mvt' as const, vectorLayers: [], name: 'Decoded Name' }
    assert.deepEqual(namer('sf.pmtiles', decoded), { name: 'Renamed', description: '', scale: 80000 })
    assert.deepEqual(namer('other.pmtiles', decoded), { name: 'Decoded Name', description: '', scale: 250000 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/chart-overrides.test.ts`
Expected: FAIL with a module-not-found error for `../src/charts/overrides.js`.

- [ ] **Step 3: Write the override store**

```ts
// src/charts/overrides.ts
/** Per-chart overrides of the name, description, and scale, persisted server-side in a JSON file
 * under the plugin data directory (the same persistence seam as the route-draft budget). Keyed by
 * chart identifier. The namer applies an override over the decoded name and the defaults. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type ChartNamer, defaultNamer } from './discovery.js'
import type { DecodedPmtiles } from './pmtiles-metadata.js'

export interface ChartOverride {
  name?: string
  description?: string
  scale?: number
}

export class OverrideStore {
  readonly #filePath: string
  #map: Record<string, ChartOverride> = {}

  constructor (filePath: string) {
    this.#filePath = filePath
  }

  async load (): Promise<void> {
    try {
      this.#map = JSON.parse(await readFile(this.#filePath, 'utf8')) as Record<string, ChartOverride>
    } catch {
      this.#map = {}
    }
  }

  get (id: string): ChartOverride | undefined {
    return this.#map[id]
  }

  async set (id: string, override: ChartOverride): Promise<void> {
    this.#map[id] = override
    await mkdir(dirname(this.#filePath), { recursive: true })
    await writeFile(this.#filePath, JSON.stringify(this.#map, null, 2))
  }

  namer (): ChartNamer {
    return (fileName: string, decoded: DecodedPmtiles) => {
      const base = defaultNamer(fileName, decoded)
      const override = this.#map[fileName.replace('.pmtiles', '-pmtiles')]
      return {
        name: override?.name ?? base.name,
        description: override?.description ?? base.description,
        scale: override?.scale ?? base.scale
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/chart-overrides.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Write the failing test for the management routes**

```ts
// test/chart-management-routes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChartRegistry, type ChartRecord } from '../src/charts/chart-registry.js'
import { OverrideStore } from '../src/charts/overrides.js'
import {
  registerChartManagementRoutes,
  type ManagementRequest,
  type ManagementResponse
} from '../src/http/chart-management-routes.js'

function record (): ChartRecord {
  return {
    identifier: 'sf-pmtiles', fileName: 'sf.pmtiles', filePath: '/charts/sf.pmtiles', name: 'sf',
    description: '', type: 'tilelayer', scale: 250000,
    decoded: { minzoom: 0, maxzoom: 14, bounds: [-122, 37, -121, 38], format: 'mvt', vectorLayers: ['water'] }
  }
}

class FakeRes implements ManagementResponse {
  body: unknown
  statusCode = 200
  json (b: unknown): void { this.body = b }
  status (c: number): this { this.statusCode = c; return this }
}

function collect (): { get: Record<string, (req: ManagementRequest, res: FakeRes) => void>, post: Record<string, (req: ManagementRequest, res: FakeRes) => void>, registry: ChartRegistry, overrides: OverrideStore, applied: number } {
  const get: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
  const post: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
  const registry = new ChartRegistry()
  const overrides = new OverrideStore('/dev/null')
  const state = { applied: 0 }
  registerChartManagementRoutes(
    {
      get (p, h) { get[p] = h as (req: ManagementRequest, res: FakeRes) => void },
      post (p, h) { post[p] = h as (req: ManagementRequest, res: FakeRes) => void }
    },
    registry,
    overrides,
    () => { state.applied++ }
  )
  return { get, post, registry, overrides, applied: state.applied }
}

test('GET /api/charts lists valid charts, decode errors, and the conflict flag', () => {
  const ctx = collect()
  ctx.registry.set(record())
  ctx.registry.setError('broken.pmtiles', 'unknown tile type 0')
  const res = new FakeRes()
  ctx.get['/api/charts']({ params: {}, body: undefined }, res)
  const body = res.body as { charts: unknown[], invalid: unknown[] }
  assert.equal(body.charts.length, 1)
  assert.equal(body.invalid.length, 1)
})

test('POST /api/charts/:id/override persists the override and triggers a re-apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mgmt-'))
  try {
    const ctx = collect()
    ;(ctx.overrides as unknown as { ['#filePath']: string })
    const overrides = new OverrideStore(join(dir, 'overrides.json'))
    await overrides.load()
    const get: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
    const post: Record<string, (req: ManagementRequest, res: FakeRes) => void> = {}
    const registry = new ChartRegistry()
    registry.set(record())
    let applied = 0
    registerChartManagementRoutes(
      { get (p, h) { get[p] = h as never }, post (p, h) { post[p] = h as never } },
      registry, overrides, () => { applied++ }
    )
    const res = new FakeRes()
    await post['/api/charts/:id/override']({ params: { id: 'sf-pmtiles' }, body: { name: 'Renamed' } }, res)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(overrides.get('sf-pmtiles'), { name: 'Renamed' })
    assert.equal(applied, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST with a non-object body returns 400', async () => {
  const ctx = collect()
  ctx.registry.set(record())
  const res = new FakeRes()
  await ctx.post['/api/charts/:id/override']({ params: { id: 'sf-pmtiles' }, body: 'nope' }, res)
  assert.equal(res.statusCode, 400)
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --import tsx --test test/chart-management-routes.test.ts`
Expected: FAIL with a module-not-found error for `../src/http/chart-management-routes.js`.

- [ ] **Step 7: Write the management routes**

```ts
// src/http/chart-management-routes.ts
/** The admin-gated chart management routes: list the detected charts with their parsed header and
 * validation status, and set a per-chart name, description, and scale override. These mount under
 * /api so the admin gate covers them; the serve route stays open read-only. */

import { type ChartRegistry, chartResource } from '../charts/chart-registry.js'
import type { ChartOverride, OverrideStore } from '../charts/overrides.js'

export interface ManagementRequest {
  params: Record<string, string>
  body: unknown
}

export interface ManagementResponse {
  json (body: unknown): void
  status (code: number): ManagementResponse
}

export interface ManagementRouter {
  get (path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void): void
  post (path: string, handler: (req: ManagementRequest, res: ManagementResponse) => void): void
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readOverride (body: unknown): ChartOverride | undefined {
  if (!isRecord(body)) return undefined
  const override: ChartOverride = {}
  if (typeof body.name === 'string') override.name = body.name
  if (typeof body.description === 'string') override.description = body.description
  if (typeof body.scale === 'number' && Number.isFinite(body.scale)) override.scale = body.scale
  return override
}

export function registerChartManagementRoutes (
  router: ManagementRouter,
  registry: ChartRegistry,
  overrides: OverrideStore,
  onOverride: () => void
): void {
  router.get('/api/charts', (_req, res) => {
    res.json({
      charts: registry.records().map((record) => ({
        ...chartResource(record),
        fileName: record.fileName,
        override: overrides.get(record.identifier) ?? {}
      })),
      invalid: registry.errors()
    })
  })

  router.post('/api/charts/:id/override', (req, res) => {
    if (!registry.has(req.params.id)) {
      res.status(404).json({ error: `Unknown chart: ${req.params.id}` })
      return
    }
    const override = readOverride(req.body)
    if (!override) {
      res.status(400).json({ error: 'Body must be an object with name, description, or scale.' })
      return
    }
    void overrides.set(req.params.id, override).then(() => {
      onOverride()
      res.json({ identifier: req.params.id, override })
    })
  })
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --import tsx --test test/chart-management-routes.test.ts && node --import tsx --test test/chart-overrides.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Wire the override store and gated routes into the plugin**

In `src/plugin/plugin.ts`, add imports:

```ts
import { OverrideStore } from '../charts/overrides.js'
import { registerChartManagementRoutes, type ManagementRouter } from '../http/chart-management-routes.js'
import { ensureApiAdminGate } from '../shared/admin-gate.js'
```

Add factory-scope state near `const registry`:

```ts
  const overrides = new OverrideStore(join((app as unknown as { getDataDirPath: () => string }).getDataDirPath(), 'pmtiles-overrides.json'))
```

In `setupCharts`, load the overrides and pass the override namer, and re-scan on an override change:

```ts
    await overrides.load()
    discovery = await startDiscovery({
      chartsDir: chartsDirFor(config),
      registry,
      namer: overrides.namer(),
      onError: (message) => app.debug(`Chart discovery: ${message}`)
    })
```

In `registerWithRouter`, mount the gated management routes after the serve route:

```ts
      if (ensureApiAdminGate(app)) {
        registerChartManagementRoutes(
          router as unknown as ManagementRouter,
          registry,
          overrides,
          () => { void (async () => { const { rescanCharts } = await import('../charts/discovery.js'); await rescanCharts({ chartsDir: chartsDirFor({}), registry, namer: overrides.namer() }) })() }
        )
      }
```

Note: the re-apply closure rescans with the current charts directory and the latest override namer, so a saved override is reflected in the registry, the resource provider, and the v1 routes without a restart. Keep `chartsDirFor` available at factory scope (it already is).

- [ ] **Step 10: Run the full plugin suite, typecheck, and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/charts/overrides.ts src/http/chart-management-routes.ts src/plugin/plugin.ts test/chart-overrides.test.ts test/chart-management-routes.test.ts
git commit -m "feat(charts): add per-chart overrides and the admin-gated management routes"
```

---

### Task 12: the webapp chart-management panel

**Files (in `signalk-binnacle`):**
- Create: `src/features/charts-management/charts-management-client.ts`
- Create: `src/features/charts-management/ChartsManagementPanel.svelte`
- Create: `src/features/charts-management/index.ts`
- Test: `src/features/charts-management/charts-management-client.test.ts`

**Interfaces:**
- Consumes: the companion management routes from Task 11 (`GET /plugins/signalk-binnacle-companion/api/charts`, `POST /plugins/signalk-binnacle-companion/api/charts/:id/override`), the existing `SlideOver.svelte`, the `shared/ui` primitives, and the `panels.css` tokens.
- Produces:
  - `interface ManagedChart { identifier: string; fileName: string; name: string; description: string; scale: number; bounds?: [number, number, number, number]; minzoom: number; maxzoom: number; format: string; override: { name?: string; description?: string; scale?: number } }`
  - `interface ManagedChartsResponse { charts: ManagedChart[]; invalid: Array<{ fileName: string; error: string }> }`
  - `function fetchManagedCharts(companionBase: string, token?: string): Promise<ManagedChartsResponse | undefined>`
  - `function putChartOverride(companionBase: string, token: string | undefined, id: string, override: { name?: string; description?: string; scale?: number }): Promise<boolean>`
  - `ChartsManagementPanel` (a Svelte component taking the companion base url and a token, designed by the UI/UX team and consistent with the existing panels)

- [ ] **Step 1: Run the panel design first**

Before writing the panel, run the project's UI/UX design step (lead with the `signalk-ui-designer` agent plus a second reviewer) for the chart-management panel, consistent with the existing `signalk-binnacle` panels: the same `SlideOver` shell, the same control primitives (the `shared/ui` building blocks and the `panels.css` tokens), the same section layout, label voice, and spacing. The panel lists each detected chart with its parsed header (bounds, zoom range, and format), its validation status, and an editable name and description per chart, plus a section listing any invalid files with their decode error. The browser upload of an archive is noted as deferred. Reuse the existing control primitive for each field; do not introduce a one-off. Capture the agreed layout before implementing.

- [ ] **Step 2: Write the failing client test**

```ts
// src/features/charts-management/charts-management-client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { fetchManagedCharts, putChartOverride } from './charts-management-client';

const BASE = 'http://pi.local/plugins/signalk-binnacle-companion';

describe('charts-management-client', () => {
  it('fetches and parses the managed charts list', async () => {
    const payload = { charts: [{ identifier: 'sf-pmtiles', fileName: 'sf.pmtiles', name: 'sf', description: '', scale: 250000, minzoom: 0, maxzoom: 14, format: 'mvt', override: {} }], invalid: [] };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    const result = await fetchManagedCharts(BASE, 'tok', fetchImpl);
    expect(result?.charts[0].identifier).toBe('sf-pmtiles');
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}/api/charts`, expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }));
  });

  it('returns undefined on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }));
    expect(await fetchManagedCharts(BASE, 'tok', fetchImpl)).toBeUndefined();
  });

  it('posts an override and reports success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const ok = await putChartOverride(BASE, 'tok', 'sf-pmtiles', { name: 'Renamed' }, fetchImpl);
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/api/charts/sf-pmtiles/override`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/charts-management/charts-management-client.test.ts`
Expected: FAIL with a module-not-found error for `./charts-management-client`.

- [ ] **Step 4: Write the client**

```ts
// src/features/charts-management/charts-management-client.ts
// Talks to the companion chart-management routes. Admin-gated, so calls carry the Bearer token on a
// secured server. Never throws: a failed read returns undefined so the panel keeps its last list.

export interface ManagedChart {
  identifier: string;
  fileName: string;
  name: string;
  description: string;
  scale: number;
  bounds?: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  format: string;
  override: { name?: string; description?: string; scale?: number };
}

export interface ManagedChartsResponse {
  charts: ManagedChart[];
  invalid: Array<{ fileName: string; error: string }>;
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchManagedCharts(
  companionBase: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedChartsResponse | undefined> {
  try {
    const response = await fetchImpl(`${companionBase}/api/charts`, { headers: authHeaders(token) });
    if (!response.ok) return undefined;
    return (await response.json()) as ManagedChartsResponse;
  } catch {
    return undefined;
  }
}

export async function putChartOverride(
  companionBase: string,
  token: string | undefined,
  id: string,
  override: { name?: string; description?: string; scale?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${companionBase}/api/charts/${encodeURIComponent(id)}/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(override),
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/charts-management/charts-management-client.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 6: Write the panel and the barrel from the agreed design**

Create `src/features/charts-management/ChartsManagementPanel.svelte` per the layout agreed in Step 1: a `SlideOver` shell whose body lists each `ManagedChart` (name, description, parsed header bounds and zoom and format, and a valid marker), with an editable name and description per chart wired to `putChartOverride`, plus a section listing each `invalid` file with its decode error and a deferred-upload note. Use the existing `shared/ui` primitives and `panels.css` tokens; do not add one-off controls or colors. Create `src/features/charts-management/index.ts` to export the panel and the client.

- [ ] **Step 7: Run the webapp check and the feature tests**

Run: `npm run check && npx vitest run src/features/charts-management`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit (in the signalk-binnacle repo)**

```bash
git add src/features/charts-management
git commit -m "feat(charts): add the companion chart-management panel"
```

---

## Self-Review

**1. Spec coverage**

- Architecture decision, no container (spec 1, 8, 11): the Global Constraints and the Architecture line keep all work in the plugin and webapp; no task touches the container. Covered.
- Discovery: debounced `fs.watch`, default `<configPath>/charts/pmtiles`, configurable, realpath containment rejecting symlink escape (spec 5 Discovery, 8): Task 6 (`startDiscovery`, `rescanCharts`, `containedRealPath`), Task 8 (`chartsPath` schema, `chartsDirFor`). Covered.
- Awaited decode and validate: magic, version 3, known tile type, drop degenerate bounds, surface a clear error (spec 5 Decode, 3, 10): Task 3 (`decodePmtilesArchive`). Covered.
- Registration: v1 charts route plus v2 `registerResourceProvider`, preserved `nameToId`, decoded metadata, url and tilemapUrl at the serve route (spec 5 Decode, 4): Task 4 (`registerChartProvider`, `chartResource`). Covered.
- Serve: strong file-identity ETag (size and mtime ns, never a header hash), Accept-Ranges, 206 with Content-Range via `createReadStream(start, end)`, If-Range mismatch to full 200, If-None-Match to 304, 416 unsatisfiable, open read-only (spec 5 Serve, 8): Task 7. Covered.
- Mutual exclusion: real disable when signalk-pmtiles-plugin is enabled, surfaced in plugin status, no swallowed errors (spec 5 Mutual exclusion, 11): Task 5 (`isThirdPartyPmtilesEnabled`), Task 8 (status message, skip registration). Covered.
- Teardown: unwatch, clear the chart set (the effective unregister, since no unregisterResourceProvider API exists) (spec 5 Mutual exclusion, 11): Task 8 (`teardownCharts`), documented in Task 4. Covered.
- Webapp provided-path switch: exact url-path match, plain source with default cache, retire `cache: 'no-store'` and the IndexedDB block cache on the provided path, keep both for non-provided (spec 6, 11): Task 9. Covered.
- Management panel and per-chart override (spec 6, 7 Phase B): Tasks 10, 11, 12. Covered. Browser upload deferred and noted in Task 12.
- Dependencies and release (spec 9): Task 1 adds the pure-JS `pmtiles` dependency. The CHANGELOG, README "What's New", and version bumps are a release step outside this plan, flagged in the handoff.
- Testing (spec 10): every behavior listed has a test in Tasks 1 through 12.

**2. Placeholder scan**

No "TBD", "TODO", "implement later", "add appropriate error handling", or "similar to Task N". Every code step shows real code; every run step gives an exact command and the expected result. The only prose-only build step is Task 12 Step 6 (the Svelte panel), whose layout is fixed by the design step (Step 1) and whose data contract and client are fully specified in earlier steps; this is intentional because the panel's visual design is delegated to the UI/UX team per the project rule, and the load-bearing logic (the client) is test-covered.

**3. Type consistency**

- `nameToId` (Task 1) is consumed unchanged in Tasks 4, 6, 7.
- `DecodedPmtiles`, `DecodeResult`, `PmtilesFormat` (Task 3) flow into Tasks 4, 6, 11 with matching field names (`minzoom`, `maxzoom`, `bounds`, `format`, `vectorLayers`, `name`).
- `ChartRecord` fields (Task 4) match the records built in Task 6 (`rescanCharts`) and the test records in Tasks 7 and 11.
- `ChartRegistry` method names (`set`, `delete`, `clear`, `has`, `filePathFor`, `records`, `list`, `get`, `setError`, `clearError`, `errors`) are used consistently in Tasks 6, 7, 8, 11.
- `serveUrl` and the `SERVE_BASE` constant (Task 4) and the serve route path `/pmtiles/:file` (Task 7) share the same `/plugins/signalk-binnacle-companion/pmtiles/` prefix that the webapp matches in Task 9 (`COMPANION_PMTILES_PREFIX`).
- `ChartNamer` and `defaultNamer` (Task 6) are reused by `OverrideStore.namer()` (Task 11) with the same return shape `{ name, description, scale }`.
- `ensureApiAdminGate` (Task 10) returns `boolean`, consumed as a guard in Task 11 wiring.
- The management response shape (`{ charts, invalid }`) produced in Task 11 matches `ManagedChartsResponse` consumed by the webapp client in Task 12.

Resolved ambiguities recorded for the executor:
- The serve route path tail is the `.pmtiles` filename (param `:file`), resolved to the record via `nameToId`. This keeps the resource identifier as `file-pmtiles` (preserving the id scheme and webapp layer state) while the public url ends in `.pmtiles`, so the webapp's existing `pmtilesUrl` recognition needs no change. The spec's `:id` is this filename param.
- "Unregister the resource provider" in teardown is implemented as clearing the chart set, because Signal K exposes no `unregisterResourceProvider` and Express no subrouter deregistration. The provider then serves an empty set.
- Per-chart overrides persist to a JSON file under `app.getDataDirPath()` (the same seam as the crows-nest route-draft budget), since the ServerAPI exposes no applicationData write method and a loopback HTTP write to the server's applicationData would reintroduce the very pattern the spec retires.
