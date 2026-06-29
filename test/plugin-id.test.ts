import test from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_ID, PLUGIN_NAME, PLUGIN_DESCRIPTION, PLUGIN_REPO_URL } from '../src/shared/plugin-id.js'

test('plugin id matches the npm package name', () => {
  assert.equal(PLUGIN_ID, 'signalk-chart-locker')
})

test('plugin name and description are human readable and non-empty', () => {
  assert.equal(PLUGIN_NAME, 'Chart Locker')
  assert.ok(PLUGIN_DESCRIPTION.length > 0)
})

test('the repo url points at the github project', () => {
  assert.match(PLUGIN_REPO_URL, /github\.com\/NearlCrews\/signalk-chart-locker/)
})
