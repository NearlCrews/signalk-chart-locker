import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fakeApp } from './helpers.js'

test('fakeApp exposes the lifecycle dependencies the plugin reads', () => {
  const app = fakeApp()
  assert.equal(typeof app.config.configPath, 'string')
  assert.ok(existsSync(app.config.configPath), 'configPath is a real directory')
  assert.equal(app.getDataDirPath(), app.config.configPath)
  assert.equal(typeof app.error, 'function')
  assert.equal(typeof app.registerResourceProvider, 'function')
  assert.equal(typeof app.get, 'function')
  const unsub = app.streambundle.getSelfBus('navigation.position').onValue(() => {})
  assert.equal(typeof unsub, 'function')
})
