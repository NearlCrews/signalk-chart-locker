import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRegionsRoutes } from '../src/http/regions-routes.js'
import { loadRegionsStore, saveRegionsStore, DEFAULT_REGIONS_STORE, type SavedRegion } from '../src/runtime/regions-store.js'
import { fakeApp, fakeRegionsRes, makeRegionsRouter } from './helpers.js'

const requestBody = {
  bbox: [-1, -1, 1, 1],
  sourceIds: ['seamark'],
  minzoom: 1,
  maxzoom: 2,
  name: 'Offline area'
}
const WARM_BOOT_ID = '0123456789abcdef0123456789abcdef'
const warmJobId = (counter: number): string => `warm-${WARM_BOOT_ID}-${counter}`

async function waitFor (predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(predicate(), true, 'condition did not become true before the deadline')
}

test('a saved region reaches durable terminal state without any client status poll', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-reconcile-'))
  const { routes, router } = makeRegionsRouter()
  let statusCalls = 0
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/cache/stats')) return Response.json({ regionsFreeBytes: 1_000_000_000, perSourceAvgBytes: {} })
    if (url.endsWith('/warm') && init?.method === 'POST') return Response.json({ jobId: warmJobId(1) })
    if (url.endsWith(`/warm/${warmJobId(1)}`)) {
      statusCalls++
      return Response.json(statusCalls === 1
        ? { total: 1, done: 0, skipped: 0, bytes: 0, errors: 0, state: 'running' }
        : { total: 1, done: 1, skipped: 0, bytes: 12, errors: 0, state: 'done' })
    }
    if (url.includes('/cache/region/')) return Response.json({ bytes: 12 })
    throw new Error(`unexpected fetch ${url}`)
  }
  const handle = registerRegionsRoutes(router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl,
    pollIntervalMs: 1,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle !== false) handle.start()
  try {
    const create = routes.find(({ method, path }) => method === 'POST' && path === '/api/regions')!
    const { res } = fakeRegionsRes()
    await create.handler({ params: {}, body: requestBody }, res)
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.status === 'ready')
    assert.equal(loadRegionsStore(dataDir).regions[0]?.bytes, 12)
    assert.ok(statusCalls >= 2)
  } finally {
    if (handle !== false) await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a lost warm-start response is recovered by region lookup without orphaning metadata', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-uncertain-'))
  const { routes, router } = makeRegionsRouter()
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/cache/stats')) return Response.json({ regionsFreeBytes: 1_000_000_000, perSourceAvgBytes: {} })
    if (url.endsWith('/warm') && init?.method === 'POST') throw new Error('response lost after acceptance')
    if (url.includes('/warm/region/')) return Response.json({ jobId: warmJobId(2), total: 1, done: 1, skipped: 0, bytes: 8, errors: 0, state: 'done' })
    if (url.includes('/cache/region/')) return Response.json({ bytes: 8 })
    throw new Error(`unexpected fetch ${url}`)
  }
  const handle = registerRegionsRoutes(router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl,
    pollIntervalMs: 1,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle !== false) handle.start()
  try {
    const create = routes.find(({ method, path }) => method === 'POST' && path === '/api/regions')!
    const { responded, res } = fakeRegionsRes()
    await create.handler({ params: {}, body: requestBody }, res)
    assert.equal(responded[0]?.status, 202)
    assert.equal((responded[0]?.body as { region: { cachedBytes: number } }).region.cachedBytes, 0)
    assert.equal(loadRegionsStore(dataDir).regions.length, 1)
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.status === 'ready')
  } finally {
    if (handle !== false) await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('stopping the route handle aborts and drains an in-flight reconciliation fetch', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-stop-'))
  const { routes, router } = makeRegionsRouter()
  let started: (() => void) | undefined
  const statusStarted = new Promise<void>((resolve) => { started = resolve })
  let aborted = false
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/cache/stats')) return Response.json({ regionsFreeBytes: 1_000_000_000, perSourceAvgBytes: {} })
    if (url.endsWith('/warm') && init?.method === 'POST') return Response.json({ jobId: warmJobId(3) })
    if (url.endsWith(`/warm/${warmJobId(3)}`)) {
      started?.()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const handle = registerRegionsRoutes(router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl,
    pollIntervalMs: 1,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle !== false) handle.start()
  try {
    const create = routes.find(({ method, path }) => method === 'POST' && path === '/api/regions')!
    await create.handler({ params: {}, body: requestBody }, fakeRegionsRes().res)
    await statusStarted
    if (handle !== false) await handle.stop()
    assert.equal(aborted, true)
  } finally {
    if (handle !== false) await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('reconciliation retries a terminal snapshot after a transient persistence failure', { skip: process.platform === 'win32' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-persist-retry-'))
  const { routes, router } = makeRegionsRouter()
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/cache/stats')) return Response.json({ regionsFreeBytes: 1_000_000_000, perSourceAvgBytes: {} })
    if (url.endsWith('/warm') && init?.method === 'POST') return Response.json({ jobId: warmJobId(4) })
    if (url.endsWith(`/warm/${warmJobId(4)}`)) return Response.json({ total: 1, done: 1, skipped: 0, bytes: 4, errors: 0, state: 'done' })
    if (url.includes('/cache/region/')) return Response.json({ bytes: 4 })
    throw new Error(`unexpected fetch ${url}`)
  }
  const handle = registerRegionsRoutes(router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl,
    pollIntervalMs: 10,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle !== false) handle.start()
  try {
    const create = routes.find(({ method, path }) => method === 'POST' && path === '/api/regions')!
    await create.handler({ params: {}, body: requestBody }, fakeRegionsRes().res)
    await chmod(dataDir, 0o500)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(loadRegionsStore(dataDir).regions[0]?.status, 'downloading')
    await chmod(dataDir, 0o700)
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.status === 'ready')
  } finally {
    await chmod(dataDir, 0o700)
    if (handle !== false) await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('startup reconciliation rate is bounded for a full valid store', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-rate-'))
  const regions: SavedRegion[] = Array.from({ length: 20 }, (_, index) => ({
    id: `r-${index}`,
    name: `Region ${index}`,
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: null,
    bytes: 0,
    status: 'downloading'
  }))
  saveRegionsStore(dataDir, { ...DEFAULT_REGIONS_STORE, regions })
  let calls = 0
  const handle = registerRegionsRoutes(makeRegionsRouter().router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl: async (url) => {
      if (url.includes('/warm/region/')) {
        calls++
        return Response.json({ jobId: warmJobId(calls), total: 1, done: 0, skipped: 0, bytes: 0, errors: 0, state: 'running' })
      }
      return Response.json({ total: 1, done: 0, skipped: 0, bytes: 0, errors: 0, state: 'running' })
    },
    pollIntervalMs: 1,
    reconciliationRequestSpacingMs: 10
  })
  assert.notEqual(handle, false)
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls, 0, 'registration alone does not start background reconciliation')
    if (handle !== false) handle.start()
    await new Promise((resolve) => setTimeout(resolve, 48))
    assert.ok(calls <= 6, `expected a bounded request rate, saw ${calls} lookups`)
  } finally {
    if (handle !== false) await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('reconciliation can restart after stop without polling while stopped', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-restart-'))
  saveRegionsStore(dataDir, {
    ...DEFAULT_REGIONS_STORE,
    regions: [{
      id: 'restart',
      name: 'Restart',
      bbox: [-1, -1, 1, 1],
      sourceIds: ['seamark'],
      minzoom: 1,
      maxzoom: 2,
      createdAt: 1,
      lastDownloadedAt: null,
      bytes: 0,
      status: 'downloading'
    }]
  })
  let calls = 0
  const handle = registerRegionsRoutes(makeRegionsRouter().router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl: async () => {
      calls++
      return Response.json({ jobId: warmJobId(5), total: 1, done: 0, skipped: 0, bytes: 0, errors: 0, state: 'running' })
    },
    pollIntervalMs: 2,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle === false) return
  try {
    handle.start()
    await waitFor(() => calls > 0)
    await handle.stop()
    const stoppedAt = calls
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls, stoppedAt)
    handle.start()
    await waitFor(() => calls > stoppedAt)
  } finally {
    await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a failed re-download keeps the previous durable byte total until an authoritative total is available', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-redownload-bytes-'))
  const region: SavedRegion = {
    id: 'redownload',
    name: 'Existing',
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: 1,
    bytes: 90,
    status: 'ready'
  }
  saveRegionsStore(dataDir, { ...DEFAULT_REGIONS_STORE, regions: [region] })
  const { routes, router } = makeRegionsRouter()
  let totalsAvailable = false
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/warm') && init?.method === 'POST') return Response.json({ jobId: warmJobId(6) })
    if (url.endsWith(`/warm/${warmJobId(6)}`)) {
      return Response.json({ total: 2, done: 1, skipped: 1, bytes: 2, errors: 1, state: 'error' })
    }
    if (url.includes('/cache/region/')) {
      return totalsAvailable ? Response.json({ bytes: 55 }) : new Response('', { status: 503 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const handle = registerRegionsRoutes(router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl,
    pollIntervalMs: 2,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle === false) return
  handle.start()
  try {
    const redownload = routes.find(({ method, path }) => method === 'POST' && path === '/api/regions/:id/redownload')!
    await redownload.handler({ params: { id: region.id }, body: {} }, fakeRegionsRes().res)
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.status === 'error')
    assert.equal(loadRegionsStore(dataDir).regions[0]?.bytes, 90)
    totalsAvailable = true
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.bytes === 55)
  } finally {
    await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a successful job with skipped tiles does not replace durable bytes with the job delta', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-skipped-bytes-'))
  const region: SavedRegion = {
    id: 'skipped',
    name: 'Skipped',
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: 1,
    bytes: 77,
    status: 'downloading'
  }
  saveRegionsStore(dataDir, { ...DEFAULT_REGIONS_STORE, regions: [region] })
  let totalsAvailable = false
  const handle = registerRegionsRoutes(makeRegionsRouter().router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl: async (url) => {
      if (url.includes('/warm/region/') || url.endsWith(`/warm/${warmJobId(7)}`)) {
        return Response.json({ jobId: warmJobId(7), total: 3, done: 1, skipped: 2, bytes: 5, errors: 0, state: 'done' })
      }
      if (url.includes('/cache/region/')) {
        return totalsAvailable ? Response.json({ bytes: 88 }) : new Response('', { status: 503 })
      }
      throw new Error(`unexpected fetch ${url}`)
    },
    pollIntervalMs: 2,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle === false) return
  handle.start()
  try {
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.status === 'ready')
    assert.equal(loadRegionsStore(dataDir).regions[0]?.bytes, 77)
    totalsAvailable = true
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.bytes === 88)
  } finally {
    await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('unavailable terminal byte totals do not rewrite durable state on every retry', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'region-terminal-wear-'))
  const region: SavedRegion = {
    id: 'wear',
    name: 'Wear',
    bbox: [-1, -1, 1, 1],
    sourceIds: ['seamark'],
    minzoom: 1,
    maxzoom: 2,
    createdAt: 1,
    lastDownloadedAt: null,
    bytes: 42,
    status: 'downloading'
  }
  saveRegionsStore(dataDir, { ...DEFAULT_REGIONS_STORE, regions: [region] })
  const handle = registerRegionsRoutes(makeRegionsRouter().router, fakeApp() as never, () => 'cache:8080', {
    dataDir,
    fetchImpl: async (url) => {
      if (url.includes('/warm/region/')) {
        return Response.json({ jobId: warmJobId(8), total: 1, done: 1, skipped: 0, bytes: 1, errors: 0, state: 'done' })
      }
      if (url.includes('/cache/region/')) return new Response('', { status: 503 })
      throw new Error(`unexpected fetch ${url}`)
    },
    pollIntervalMs: 2,
    reconciliationRequestSpacingMs: 0
  })
  assert.notEqual(handle, false)
  if (handle === false) return
  handle.start()
  try {
    await waitFor(() => loadRegionsStore(dataDir).regions[0]?.status === 'ready')
    const initial = loadRegionsStore(dataDir).regions[0]!
    const identity = await stat(join(dataDir, 'regions.json'), { bigint: true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const after = loadRegionsStore(dataDir).regions[0]!
    const afterIdentity = await stat(join(dataDir, 'regions.json'), { bigint: true })
    assert.equal(after.lastDownloadedAt, initial.lastDownloadedAt)
    assert.equal(after.bytes, 42)
    assert.equal(afterIdentity.ino, identity.ino)
    assert.equal(afterIdentity.mtimeNs, identity.mtimeNs)
  } finally {
    await handle.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})
