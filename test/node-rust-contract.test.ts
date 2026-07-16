import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSourcePayload, pushTilecacheConfig } from '../src/runtime/tilecache-config-push.js'

const configuredBinary = process.env.TILECACHE_BIN
const binary = configuredBinary ?? resolve('container/target/debug/tilecache')
const binaryMissing = !existsSync(binary)
const OUTPUT_LIMIT = 64 * 1024

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
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      TILECACHE_PORT: String(port),
      TILECACHE_DB: join(dir, 'cache.sqlite'),
      TILECACHE_CAP_BYTES: String(16 * 1024 * 1024),
      TILECACHE_CONTROL_TOKEN: token,
      TILECACHE_GEOCODING_ENABLED: '0'
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
    await rm(dir, { recursive: true, force: true })
    assert.equal(stopped, true, `tilecache child did not exit after SIGTERM and SIGKILL; ${diagnostics(stderr, stdout, spawnError)}`)
  }
})
