import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerManager } from '../src/shared/types.js'
import {
  getContainerManager,
  requireContainerManager,
  ensureRuntimeReady
} from '../src/runtime/container-manager.js'

interface FakeApp {
  errors: string[]
  setPluginError(message: string): void
}

function fakeApp (): FakeApp {
  return { errors: [], setPluginError (m: string) { this.errors.push(m) } }
}

function fakeManager (runtimePresent: boolean): ContainerManager {
  return {
    async whenReady () {},
    getRuntime () { return runtimePresent ? { runtime: 'docker' } : null },
    async ensureRunning () {},
    async resolveContainerAddress () { return '127.0.0.1:8080' },
    async stop () {}
  }
}

test.afterEach(() => {
  delete (globalThis as Record<string, unknown>).__signalk_containerManager
})

test('getContainerManager returns null when the global is absent', () => {
  assert.equal(getContainerManager(), null)
})

test('requireContainerManager sets a plugin error when the manager is missing', () => {
  const app = fakeApp()
  const result = requireContainerManager(app as never)
  assert.equal(result, null)
  assert.equal(app.errors.length, 1)
})

test('requireContainerManager returns the manager when present', () => {
  const manager = fakeManager(true)
  ;(globalThis as Record<string, unknown>).__signalk_containerManager = manager
  const app = fakeApp()
  assert.equal(requireContainerManager(app as never), manager)
  assert.equal(app.errors.length, 0)
})

test('ensureRuntimeReady is false and reports when no runtime is detected', async () => {
  const app = fakeApp()
  const ready = await ensureRuntimeReady(app as never, fakeManager(false))
  assert.equal(ready, false)
  assert.equal(app.errors.length, 1)
})

test('ensureRuntimeReady is true when a runtime is detected', async () => {
  const app = fakeApp()
  const ready = await ensureRuntimeReady(app as never, fakeManager(true))
  assert.equal(ready, true)
  assert.equal(app.errors.length, 0)
})
