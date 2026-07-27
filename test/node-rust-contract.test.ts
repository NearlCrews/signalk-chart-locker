import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChartSource, LngLatBbox, ZoomRange } from 'signalk-chart-sources'
import { buildSourcePayload, pushTilecacheConfig } from '../src/runtime/tilecache-config-push.js'

const configuredBinary = process.env.TILECACHE_BIN
const binary = configuredBinary ?? resolve('container/target/debug/tilecache')
const binaryMissing = !existsSync(binary)
const OUTPUT_LIMIT = 64 * 1024
const NOAA_SOURCE_ID = 'depth-noaa-enc'
const OUTSIDE_NOAA_COVERAGE: LngLatBbox = [145, -40, 150, -35]
const IN_NOAA_COVERAGE: LngLatBbox = [-83.1, 42.2, -82.9, 42.4]
const NOAA_ZOOMS: ZoomRange = [6, 6]
const chartSources = import('signalk-chart-sources')

function appendOutput (current: string, chunk: Buffer | string): string {
  if (current.length >= OUTPUT_LIMIT) return current
  return (current + chunk.toString()).slice(0, OUTPUT_LIMIT)
}

function diagnostics (stderr: string, stdout: string, spawnError: unknown): string {
  const parts = []
  if (spawnError !== undefined) parts.push(`spawn error: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`)
  if (stderr.trim() !== '') parts.push(`stderr:\n${stderr.trim()}`)
  if (stdout.trim() !== '') parts.push(`stdout:\n${stdout.trim()}`)
  return parts.length === 0 ? 'no child output captured' : parts.join('\n')
}

async function settlesWithin (operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, timeoutMs) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function unusedPort (): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('Node control clients satisfy the real Rust tilecache contract', { skip: configuredBinary === undefined && binaryMissing }, async () => {
  assert.equal(binaryMissing, false, `TILECACHE_BIN does not exist: ${binary}`)
  const dir = await mkdtemp(join(tmpdir(), 'node-rust-contract-'))
  const port = await unusedPort()
  const token = 'node-rust-contract-token'
  let upstreamHits = 0
  const upstream = createHttpServer((_request, response) => {
    upstreamHits++
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(Buffer.from([1, 2, 3, 4]))
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { reject(error) }
    upstream.once('error', failed)
    upstream.listen(0, '127.0.0.1', () => {
      upstream.removeListener('error', failed)
      resolve()
    })
  })
  const upstreamAddress = upstream.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object')
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      TILECACHE_PORT: String(port),
      TILECACHE_DB: join(dir, 'cache.sqlite'),
      TILECACHE_CAP_BYTES: String(16 * 1024 * 1024),
      TILECACHE_CONTROL_TOKEN: token,
      TILECACHE_GEOCODING_ENABLED: '0',
      TILECACHE_ALLOW_PRIVATE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let spawnError: unknown
  child.stdout.on('data', (chunk: Buffer | string) => { stdout = appendOutput(stdout, chunk) })
  child.stderr.on('data', (chunk: Buffer | string) => { stderr = appendOutput(stderr, chunk) })
  child.once('error', (error) => { spawnError = error })
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  const address = `127.0.0.1:${port}`
  try {
    const deadline = Date.now() + 10_000
    let healthy = false
    while (!healthy && Date.now() < deadline) {
      healthy = await fetch(`http://${address}/health`).then((response) => response.ok).catch(() => false)
      if (spawnError !== undefined || child.exitCode !== null || child.signalCode !== null) break
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(healthy, true, `tilecache did not become healthy; ${diagnostics(stderr, stdout, spawnError)}`)

    const payload = await buildSourcePayload(16 * 1024 * 1024, 8 * 1024 * 1024, 1024 * 1024, 0, false)
    const pushed = await pushTilecacheConfig(address, payload, { controlToken: token })
    assert.equal(pushed.ok, true)

    const { chartSourceById, tileCountInBbox } = await chartSources
    const noaaSource = chartSourceById(NOAA_SOURCE_ID)
    assert.ok(noaaSource)
    assert.equal(noaaSource.upstream.mode, 'wms')
    if (noaaSource.upstream.mode !== 'wms') throw new Error('NOAA ENC must remain a WMS source')
    const controlledNoaa: ChartSource = {
      ...noaaSource,
      upstream: {
        ...noaaSource.upstream,
        base: `http://127.0.0.1:${upstreamAddress.port}/wms`
      }
    }
    const controlledPayload = {
      ...payload,
      sources: payload.sources.map((source) => source.id === NOAA_SOURCE_ID ? controlledNoaa : source)
    }
    const controlledPush = await pushTilecacheConfig(address, controlledPayload, { controlToken: token })
    assert.equal(controlledPush.ok, true)

    const warmHeaders = {
      'content-type': 'application/json',
      'x-tilecache-token': token
    }
    const outsideWarm = await fetch(`http://${address}/warm`, {
      method: 'POST',
      headers: warmHeaders,
      body: JSON.stringify({
        sources: [NOAA_SOURCE_ID],
        bbox: OUTSIDE_NOAA_COVERAGE,
        minzoom: NOAA_ZOOMS[0],
        maxzoom: NOAA_ZOOMS[1]
      })
    })
    assert.equal(outsideWarm.status, 400)
    assert.equal(upstreamHits, 0, 'out-of-coverage NOAA regions must not fetch tiles')

    const expectedTiles = tileCountInBbox(noaaSource, IN_NOAA_COVERAGE, NOAA_ZOOMS)
    assert.ok(expectedTiles > 0)
    const insideWarm = await fetch(`http://${address}/warm`, {
      method: 'POST',
      headers: warmHeaders,
      body: JSON.stringify({
        sources: [NOAA_SOURCE_ID],
        bbox: IN_NOAA_COVERAGE,
        minzoom: NOAA_ZOOMS[0],
        maxzoom: NOAA_ZOOMS[1]
      })
    })
    assert.equal(insideWarm.status, 200)
    const { jobId } = await insideWarm.json() as { jobId?: unknown }
    assert.equal(typeof jobId, 'string')

    let snapshot: { state?: unknown, total?: unknown } | undefined
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await fetch(`http://${address}/warm/${encodeURIComponent(jobId as string)}`)
      assert.equal(response.status, 200)
      snapshot = await response.json() as { state?: unknown, total?: unknown }
      if (snapshot.state !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(snapshot?.state, 'done')
    assert.equal(snapshot.total, expectedTiles, 'Rust warming must match the shared TypeScript tile count')
    assert.equal(upstreamHits, expectedTiles, 'Rust warming must fetch each covered NOAA tile once')

    assert.equal((await fetch(`http://${address}/warm/region/missing`)).status, 404)
    assert.equal((await fetch(`http://${address}/cache/clear-scroll`, { method: 'POST' })).status, 401)
    assert.equal((await fetch(`http://${address}/cache/clear-scroll`, {
      method: 'POST',
      headers: { 'x-tilecache-token': token }
    })).status, 200)
    assert.equal((await fetch(`http://${address}/geocode?lat=1&lon=2`)).status, 404)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    let stopped = await settlesWithin(closed, 2000)
    if (!stopped) {
      child.kill('SIGKILL')
      stopped = await settlesWithin(closed, 2000)
    }
    upstream.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
    })
    await rm(dir, { recursive: true, force: true })
    assert.equal(stopped, true, `tilecache child did not exit after SIGTERM and SIGKILL; ${diagnostics(stderr, stdout, spawnError)}`)
  }
})
