import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isThirdPartyPmtilesEnabled, watchThirdPartyPmtilesEnabled } from '../src/charts/mutual-exclusion.js'

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

test('reports false when config file is malformed JSON', async () => {
  const dir = await configDir('not valid json at all {')
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports false for a valid JSON scalar without renaming another plugin config', async () => {
  const dir = await configDir('null')
  try {
    assert.equal(isThirdPartyPmtilesEnabled(dir), false)
    assert.deepEqual(await import('node:fs/promises').then(({ readdir }) => readdir(join(dir, 'plugin-config-data'))), ['pmtiles-chart-provider.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('watcher reports live enable and disable transitions', async () => {
  const dir = await configDir(JSON.stringify({ enabled: false }))
  const file = join(dir, 'plugin-config-data', 'pmtiles-chart-provider.json')
  const transitions: boolean[] = []
  const watcher = watchThirdPartyPmtilesEnabled(dir, (enabled) => transitions.push(enabled), { intervalMs: 10 })
  try {
    await writeFile(file, JSON.stringify({ enabled: true }))
    const enabledDeadline = Date.now() + 1000
    while (!transitions.includes(true) && Date.now() < enabledDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFile(file, JSON.stringify({ enabled: false }))
    const disabledDeadline = Date.now() + 1000
    while (transitions.at(-1) !== false && Date.now() < disabledDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(transitions, [true, false])
  } finally {
    await watcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('watcher retries a failed async transition without another configuration change', async () => {
  const dir = await configDir(JSON.stringify({ enabled: false }))
  const file = join(dir, 'plugin-config-data', 'pmtiles-chart-provider.json')
  let attempts = 0
  let applied = false
  const errors: unknown[] = []
  const watcher = watchThirdPartyPmtilesEnabled(dir, async (enabled) => {
    attempts++
    if (attempts === 1) throw new Error('transient transition failure')
    applied = enabled
  }, { intervalMs: 10, retryBaseMs: 5, onError: (error) => errors.push(error) })
  try {
    await writeFile(file, JSON.stringify({ enabled: true }))
    const deadline = Date.now() + 1000
    const isApplied = (): boolean => applied
    while (!isApplied() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(applied, true)
    assert.equal(attempts, 2)
    assert.equal(errors.length, 1)
  } finally {
    await watcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stop drains the active transition and prevents a queued state from applying', async () => {
  const dir = await configDir(JSON.stringify({ enabled: false }))
  const file = join(dir, 'plugin-config-data', 'pmtiles-chart-provider.json')
  let started: (() => void) | undefined
  let release: (() => void) | undefined
  const transitionStarted = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const applied: boolean[] = []
  const watcher = watchThirdPartyPmtilesEnabled(dir, async (enabled) => {
    started?.()
    await gate
    applied.push(enabled)
  }, { intervalMs: 10 })
  try {
    await writeFile(file, JSON.stringify({ enabled: true }))
    await transitionStarted
    await writeFile(file, JSON.stringify({ enabled: false }))
    const stopped = watcher.stop()
    release?.()
    await stopped
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(applied, [true])
  } finally {
    release?.()
    await watcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
