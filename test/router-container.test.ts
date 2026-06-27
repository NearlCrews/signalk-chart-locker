import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUTER_INTERNAL_PORT,
  buildRouterConfig,
  probeRouterHealth
} from '../src/runtime/router-container.js'

test('the container config requests the accessible port and never a manual ports field', () => {
  const config = buildRouterConfig()
  assert.deepEqual(config.signalkAccessiblePorts, [ROUTER_INTERNAL_PORT])
  assert.equal('ports' in config, false)
  assert.equal('networkMode' in config, false)
  assert.equal(config.resources?.memory, config.resources?.memorySwap)
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
