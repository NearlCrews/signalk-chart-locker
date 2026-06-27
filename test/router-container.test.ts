import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerConfig, ContainerManager } from '../src/shared/types.js'
import {
  ROUTER_CONTAINER_NAME,
  ROUTER_INTERNAL_PORT,
  buildRouterConfig,
  startRouterContainer,
  probeRouterHealth
} from '../src/runtime/router-container.js'

test('the container config requests the accessible port and never a manual ports field', () => {
  const config = buildRouterConfig()
  assert.deepEqual(config.signalkAccessiblePorts, [ROUTER_INTERNAL_PORT])
  assert.equal('ports' in config, false)
  assert.equal('networkMode' in config, false)
  assert.equal(config.resources?.memory, config.resources?.memorySwap)
})

test('startRouterContainer ensures the container, forwards the plugin id, and returns the resolved address', async () => {
  const calls: Array<{ name: string; config: ContainerConfig; options?: { pluginId?: string } }> = []
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (name, config, options) { calls.push({ name, config, options }) },
    async resolveContainerAddress (name, port) {
      assert.equal(name, ROUTER_CONTAINER_NAME)
      assert.equal(port, ROUTER_INTERNAL_PORT)
      return '127.0.0.1:8080'
    },
    async stop () {}
  }
  const address = await startRouterContainer(manager, { tag: 'v1', pluginId: 'signalk-binnacle-companion' })
  assert.equal(address, '127.0.0.1:8080')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, ROUTER_CONTAINER_NAME)
  assert.equal(calls[0].config.tag, 'v1')
  assert.equal(calls[0].options?.pluginId, 'signalk-binnacle-companion')
})

test('startRouterContainer omits the options object when no plugin id is given', async () => {
  const calls: Array<{ options?: { pluginId?: string } }> = []
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning (_name, _config, options) { calls.push({ options }) },
    async resolveContainerAddress () { return '127.0.0.1:8080' },
    async stop () {}
  }
  await startRouterContainer(manager)
  assert.equal(calls[0].options, undefined)
})

test('startRouterContainer throws when no address is resolvable', async () => {
  const manager: ContainerManager = {
    async whenReady () {},
    getRuntime () { return { runtime: 'docker' } },
    async ensureRunning () {},
    async resolveContainerAddress () { return null },
    async stop () {}
  }
  await assert.rejects(() => startRouterContainer(manager), /address/)
})

test('probeRouterHealth is true only for a 200 with status ok', async () => {
  const ok = await probeRouterHealth('127.0.0.1:8080', async () => ({ ok: true, async json () { return { status: 'ok' } } }))
  assert.equal(ok, true)
  const badStatus = await probeRouterHealth('127.0.0.1:8080', async () => ({ ok: true, async json () { return { status: 'down' } } }))
  assert.equal(badStatus, false)
  const notOk = await probeRouterHealth('127.0.0.1:8080', async () => ({ ok: false, async json () { return {} } }))
  assert.equal(notOk, false)
})

test('probeRouterHealth is false when the fetch throws', async () => {
  const result = await probeRouterHealth('127.0.0.1:8080', async () => { throw new Error('connection refused') })
  assert.equal(result, false)
})
