import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getContainerManager,
  requireContainerManager,
  ensureRuntimeReady
} from '../src/runtime/container-manager.js'
import { fakeApp, fakeManager, setContainerManager, clearGlobals } from './helpers.js'

test.afterEach(() => {
  clearGlobals()
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
  const manager = fakeManager()
  setContainerManager(manager)
  const app = fakeApp()
  assert.equal(requireContainerManager(app as never), manager)
  assert.equal(app.errors.length, 0)
})

test('ensureRuntimeReady is false and reports when no runtime is detected', async () => {
  const app = fakeApp()
  const ready = await ensureRuntimeReady(app as never, fakeManager({ runtime: null }))
  assert.equal(ready, false)
  assert.equal(app.errors.length, 1)
})

test('ensureRuntimeReady is true when a runtime is detected', async () => {
  const app = fakeApp()
  const ready = await ensureRuntimeReady(app as never, fakeManager())
  assert.equal(ready, true)
  assert.equal(app.errors.length, 0)
})
