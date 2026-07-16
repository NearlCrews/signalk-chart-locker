// test/chart-discovery.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, rename, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChartRegistry } from '../src/charts/chart-registry.js'
import { defaultNamer, rescanCharts, startDiscovery } from '../src/charts/discovery.js'
import { hasControlCharacter } from '../src/shared/text.js'
import { buildPmtilesFixture } from './pmtiles-fixture.js'

async function chartsDir (): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'charts-'))
  await mkdir(join(dir, 'pmtiles'), { recursive: true })
  return join(dir, 'pmtiles')
}

test('default chart names replace filename control characters', () => {
  const decoded = { minzoom: 0, maxzoom: 1, format: 'mvt' as const, vectorLayers: [] }
  assert.equal(defaultNamer('Great\u2028Lakes\nChart.pmtiles', decoded).name, 'Great Lakes Chart')
})

test('rescanCharts rejects controlled filenames before decode and sanitizes diagnostics', async () => {
  const dir = await chartsDir()
  const fileName = 'hostile\u2028name\nchart.pmtiles'
  await writeFile(join(dir, fileName), buildPmtilesFixture())
  const registry = new ChartRegistry()
  const messages: string[] = []
  let decodes = 0
  try {
    await rescanCharts({
      chartsDir: dir,
      registry,
      decode: async () => { decodes++; return { ok: false as const, error: 'must not decode' } },
      onError: (message) => { messages.push(message) }
    })
    assert.equal(decodes, 0)
    assert.equal(registry.records().length, 0)
    assert.equal(registry.errors().length, 1)
    assert.match(registry.errors()[0]?.error ?? '', /control/)
    for (const value of [registry.errors()[0]?.fileName ?? '', ...messages]) {
      assert.equal(hasControlCharacter(value), false)
      assert.ok(value.length <= 200)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

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

test('rescanCharts drops a decode error whose file has been removed', async () => {
  const dir = await chartsDir()
  const file = join(dir, 'bad.pmtiles')
  await writeFile(file, buildPmtilesFixture({ magic: 'XXXXXXX' }))
  const registry = new ChartRegistry()
  try {
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.errors().length, 1)
    await rm(file)
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.errors().length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rescanCharts serializes overlapping scans for one registry', async () => {
  const dir = await chartsDir()
  await writeFile(join(dir, 'one.pmtiles'), buildPmtilesFixture())
  const registry = new ChartRegistry()
  let active = 0
  let maximum = 0
  const decode = async () => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active--
    return { ok: true as const, decoded: { minzoom: 0, maxzoom: 1, format: 'mvt' as const, vectorLayers: [] } }
  }
  try {
    await Promise.all([
      rescanCharts({ chartsDir: dir, registry, decode }),
      rescanCharts({ chartsDir: dir, registry, decode })
    ])
    assert.equal(maximum, 1)
    assert.equal(registry.discoveryStatus().valid, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rescanCharts coalesces an event storm to one pending follow-up scan', async () => {
  const dir = await chartsDir()
  await writeFile(join(dir, 'one.pmtiles'), buildPmtilesFixture())
  const registry = new ChartRegistry()
  let calls = 0
  let namings = 0
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const decode = async () => {
    calls++
    if (calls === 1) { started?.(); await gate }
    return { ok: true as const, decoded: { minzoom: 0, maxzoom: 1, format: 'mvt' as const, vectorLayers: [] } }
  }
  try {
    const deps = {
      chartsDir: dir,
      registry,
      decode,
      namer: () => { namings++; return { name: 'one', description: '', scale: 250000 } }
    }
    const first = rescanCharts(deps)
    await firstStarted
    const storm = Array.from({ length: 25 }, () => rescanCharts(deps))
    assert.equal(new Set([first, ...storm]).size, 1, 'redundant callers share one bounded completion promise')
    release?.()
    await Promise.all([first, ...storm])
    assert.equal(calls, 1, 'the follow-up scan reuses unchanged decoded metadata')
    assert.equal(namings, 2, 'one dirty follow-up scan runs after the active scan')
  } finally {
    release?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rescanCharts rejects every file in an identifier collision instead of overwriting', async () => {
  const dir = await chartsDir()
  await writeFile(join(dir, 'x.pmtiles.PMTILES'), buildPmtilesFixture())
  await writeFile(join(dir, 'x-pmtiles.PMTILES'), buildPmtilesFixture())
  const registry = new ChartRegistry()
  try {
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.records().length, 0)
    assert.equal(registry.errors().length, 2)
    assert.ok(registry.errors().every(({ error }) => error.includes('collision')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Skipped on Windows: fs.symlink needs elevated privilege there (and on Windows CI), so the setup
// throws EPERM before the assertion runs. The realpath containment this guards is platform-independent
// and is exercised on Linux and macOS.
test('rescanCharts rejects a symlink that escapes the charts directory', { skip: process.platform === 'win32' }, async () => {
  const outside = await mkdtemp(join(tmpdir(), 'outside-'))
  const target = join(outside, 'secret.pmtiles')
  await writeFile(target, buildPmtilesFixture())
  const dir = await chartsDir()
  await symlink(target, join(dir, 'escape.pmtiles'))
  const registry = new ChartRegistry()
  const messages: string[] = []
  try {
    await rescanCharts({ chartsDir: dir, registry, onError: (message) => { messages.push(message) } })
    assert.equal(registry.has('escape-pmtiles'), false)
    assert.equal(registry.errors()[0]?.fileName, 'escape.pmtiles')
    assert.match(registry.errors()[0]?.error ?? '', /outside the charts directory/)
    assert.equal(messages.some((message) => message.includes(outside)), false, 'the outside path is not exposed')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('rescanCharts reports a broken PMTiles symlink as an invalid chart', { skip: process.platform === 'win32' }, async () => {
  const dir = await chartsDir()
  await symlink(join(dir, 'missing-target'), join(dir, 'broken.pmtiles'))
  const registry = new ChartRegistry()
  try {
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.has('broken-pmtiles'), false)
    assert.equal(registry.errors()[0]?.fileName, 'broken.pmtiles')
    assert.match(registry.errors()[0]?.error ?? '', /broken/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Linux only: this asserts fs.watch fires a rescan, and fs.watch delays or drops events on macOS and
// Windows CI runners, so it flakes there. The deployment target is a Linux boat computer, and the
// rescan logic itself is exercised on every platform by the tests above that call rescanCharts directly.
test('startDiscovery picks up a file added after start, then stops watching', { skip: process.platform !== 'linux' }, async () => {
  const dir = await chartsDir()
  const registry = new ChartRegistry()
  const handle = await startDiscovery({ chartsDir: dir, registry, debounceMs: 20 })
  try {
    await writeFile(join(dir, 'late.pmtiles'), buildPmtilesFixture())
    // Poll rather than sleep a fixed interval: fs.watch is fast on Linux (inotify) but can be delayed
    // by seconds or coalesced on macOS and Windows, so a fixed wait flakes there. Give the debounced
    // rescan up to five seconds to register the new archive.
    const deadline = Date.now() + 5000
    while (!registry.has('late-pmtiles') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(registry.has('late-pmtiles'), true)
  } finally {
    await handle.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the Linux self-heal poll follows a deleted and recreated charts directory', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'charts-recreated-'))
  const dir = join(root, 'pmtiles')
  await mkdir(dir)
  const registry = new ChartRegistry()
  const handle = await startDiscovery({ chartsDir: dir, registry, debounceMs: 5, pollIntervalMs: 15 })
  try {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir)
    await writeFile(join(dir, 'reborn.pmtiles'), buildPmtilesFixture())
    const deadline = Date.now() + 2000
    while (!registry.has('reborn-pmtiles') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(registry.has('reborn-pmtiles'), true)
  } finally {
    await handle.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('the self-heal interval never overlaps slow directory identity polls', async () => {
  const dir = await chartsDir()
  let calls = 0
  let active = 0
  let maximumActive = 0
  const identity = async (): Promise<string> => {
    calls++
    active++
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active--
    return 'stable-directory'
  }
  const handle = await startDiscovery({
    chartsDir: dir,
    registry: new ChartRegistry(),
    pollIntervalMs: 1,
    directoryIdentity: identity
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 65))
  } finally {
    await handle.stop()
    await rm(dir, { recursive: true, force: true })
  }
  assert.ok(calls >= 2)
  assert.equal(maximumActive, 1)
})

test('startDiscovery creates a missing chart directory before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'charts-root-'))
  const dir = join(root, 'missing', 'pmtiles')
  const registry = new ChartRegistry()
  const handle = await startDiscovery({ chartsDir: dir, registry, debounceMs: 20 })
  try {
    assert.equal((await stat(dir)).isDirectory(), true)
  } finally {
    await handle.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('startDiscovery rejects a charts-root symlink outside its allowed root', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'charts-allowed-'))
  const outside = await mkdtemp(join(tmpdir(), 'charts-outside-'))
  const linked = join(root, 'charts')
  await symlink(outside, linked, 'dir')
  const registry = new ChartRegistry()
  const handle = await startDiscovery({ chartsDir: linked, allowedRoot: root, registry })
  try {
    assert.equal(registry.records().length, 0)
    assert.equal(registry.errors()[0]?.fileName, '<charts-directory>')
  } finally {
    await handle.stop()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('startDiscovery does not create through an intermediate symlink outside its allowed root', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'charts-allowed-'))
  const outside = await mkdtemp(join(tmpdir(), 'charts-outside-'))
  await symlink(outside, join(root, 'linked'), 'dir')
  const escaped = join(outside, 'created', 'pmtiles')
  const handle = await startDiscovery({
    chartsDir: join(root, 'linked', 'created', 'pmtiles'),
    allowedRoot: root,
    registry: new ChartRegistry()
  })
  try {
    await assert.rejects(stat(escaped), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  } finally {
    await handle.stop()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('rescanCharts rejects a file replaced while metadata is being decoded', async () => {
  const dir = await chartsDir()
  const file = join(dir, 'changing.pmtiles')
  const replacement = join(dir, 'replacement.tmp')
  await writeFile(file, buildPmtilesFixture())
  const registry = new ChartRegistry()
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const decodeStarted = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const decode = async () => {
    started?.()
    await gate
    return { ok: true as const, decoded: { minzoom: 0, maxzoom: 1, format: 'mvt' as const, vectorLayers: [] } }
  }
  try {
    const scan = rescanCharts({ chartsDir: dir, registry, decode })
    await decodeStarted
    await writeFile(replacement, buildPmtilesFixture({ maxZoom: 2 }))
    await rename(replacement, file)
    release?.()
    await scan
    assert.equal(registry.has('changing-pmtiles'), false)
    assert.match(registry.errors()[0]?.error ?? '', /changed while/i)
  } finally {
    release?.()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stop invalidates an in-flight scan before it can repopulate a cleared registry', async () => {
  const dir = await chartsDir()
  const file = join(dir, 'slow.pmtiles')
  await writeFile(file, buildPmtilesFixture())
  let calls = 0
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const scanStarted = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const decode = async () => {
    calls++
    if (calls > 1) { started?.(); await gate }
    return { ok: true as const, decoded: { minzoom: 0, maxzoom: 1, format: 'mvt' as const, vectorLayers: [] } }
  }
  const registry = new ChartRegistry()
  const handle = await startDiscovery({ chartsDir: dir, registry, decode })
  try {
    await writeFile(file, buildPmtilesFixture({ maxZoom: 2 }))
    const rescan = handle.rescan()
    await scanStarted
    const stopped = handle.stop()
    registry.clear()
    release?.()
    await Promise.all([rescan, stopped])
    assert.equal(registry.records().length, 0)
    await handle.rescan()
    assert.equal(registry.records().length, 0)
  } finally {
    release?.()
    await handle.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
