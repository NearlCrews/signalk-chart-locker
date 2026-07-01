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
  try {
    await rescanCharts({ chartsDir: dir, registry })
    assert.equal(registry.has('escape-pmtiles'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
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
    handle.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
