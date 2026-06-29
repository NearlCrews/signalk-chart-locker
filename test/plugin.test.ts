import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlugin } from '../src/plugin/plugin.js'
import { PLUGIN_ID, PLUGIN_NAME } from '../src/shared/plugin-id.js'
import { fakeApp, fakeManager, managerRecord, setContainerManager, clearGlobals } from './helpers.js'

test.afterEach(() => {
  clearGlobals()
})

test('the plugin exposes id, name, and a schema', () => {
  const plugin = createPlugin(fakeApp() as never)
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal(plugin.name, PLUGIN_NAME)
  const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
  assert.equal((schema as { type: string }).type, 'object')
})

test('createPlugin does not call getDataDirPath at construction', () => {
  // The Signal K server (interfaces/plugins.js) calls the plugin factory, then assigns
  // appCopy.getDataDirPath afterward, so getDataDirPath is absent while the factory runs. The plugin
  // must defer every getDataDirPath call to start or registerWithRouter, never the constructor.
  const appWithoutDataDir = {
    config: { configPath: '/tmp' },
    debug () {},
    setPluginStatus () {},
    setPluginError () {}
  }
  assert.doesNotThrow(() => createPlugin(appWithoutDataDir as never))
})

test('start sets a plugin error and does nothing when the container manager is missing', async () => {
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(app.errors.length, 1)
})

test('stop with no prior start and a manager present is a clean no-op', async () => {
  const record = managerRecord()
  setContainerManager(fakeManager({ record }))
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await assert.doesNotReject(async () => { await plugin.stop() })
  assert.deepEqual(record.stopped, [])
})

test('schema() cap field is integer with fixed maximum 1024, minimum 1, and default >= 1', () => {
  const plugin = createPlugin(fakeApp() as never)
  const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
  const props = (schema as { properties: Record<string, unknown> }).properties
  const cap = props.tilecacheCacheCapGiB as {
    type: string
    maximum: number
    minimum: number
    default: number
    multipleOf: number
  }
  assert.equal(cap.type, 'integer')
  assert.equal(cap.maximum, 1024)
  assert.equal(cap.minimum, 1)
  assert.ok(cap.default >= 1, 'default must be at least 1')
  assert.equal(cap.multipleOf, 1)
})

test('plugin exposes uiSchema with a range widget on the cap field', () => {
  const plugin = createPlugin(fakeApp() as never)
  const ui = (plugin as unknown as { uiSchema: Record<string, { 'ui:widget': string }> }).uiSchema
  assert.ok(ui != null, 'uiSchema must be present')
  assert.equal(ui.tilecacheCacheCapGiB['ui:widget'], 'range')
})

test('stop calls the navigation.position unsubscribe returned by streambundle', async () => {
  setContainerManager(fakeManager())
  const app = fakeApp()
  const plugin = createPlugin(app as never)
  await plugin.start({}, () => {})
  assert.equal(app.positionUnsubCalled, false)
  await plugin.stop()
  assert.equal(app.positionUnsubCalled, true)
})
