import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostHealthMonitor, type HostHealthState } from '../src/runtime/host-health-monitor.js'

test('restarts a healthy container after three failed host-side probes and re-resolves its address', async () => {
  let address: string | null = '127.0.0.1:31001'
  const states: HostHealthState[] = []
  const probed: string[] = []
  let hostProbe = 0
  let containerProbes = 0
  let restarts = 0
  let restores = 0
  const monitor = createHostHealthMonitor({
    getAddress: () => address,
    async probeHost (candidate) {
      probed.push(candidate)
      hostProbe++
      return { healthy: hostProbe >= 4, configured: hostProbe >= 4 ? false : undefined }
    },
    async probeContainer () { containerProbes++; return true },
    async restart () { restarts++; return '127.0.0.1:31002' },
    async restore (candidate) { restores++; assert.equal(candidate, '127.0.0.1:31002') },
    onAddress (next) { address = next },
    onState (state) { states.push(state) }
  })

  await monitor.checkNow()
  await monitor.checkNow()
  await monitor.checkNow()

  assert.equal(containerProbes, 1)
  assert.equal(restarts, 1)
  assert.equal(restores, 1)
  assert.equal(address, '127.0.0.1:31002')
  assert.deepEqual(probed, [
    '127.0.0.1:31001',
    '127.0.0.1:31001',
    '127.0.0.1:31001',
    '127.0.0.1:31002'
  ])
  assert.equal(states.some((state) => state.status === 'restarting'), true)
  assert.deepEqual(states.at(-2), { status: 'restoring' })
  assert.deepEqual(states.at(-1), { status: 'recovered' })
  await monitor.stop()
})

test('does not restart when the in-container healthcheck also fails', async () => {
  const states: HostHealthState[] = []
  let restarts = 0
  const monitor = createHostHealthMonitor({
    getAddress: () => '127.0.0.1:31001',
    async probeHost () { return { healthy: false } },
    async probeContainer () { return false },
    async restart () { restarts++; return '127.0.0.1:31002' },
    async restore () {},
    onAddress () {},
    onState (state) { states.push(state) }
  })

  await monitor.checkNow()
  await monitor.checkNow()
  await monitor.checkNow()

  assert.equal(restarts, 0)
  assert.deepEqual(states.at(-1), { status: 'container-unhealthy' })
  await monitor.stop()
})

test('an initial configuration retry still requires a healthy container before recreation', async () => {
  let restarts = 0
  const states: HostHealthState[] = []
  const monitor = createHostHealthMonitor({
    getAddress: () => '127.0.0.1:31001',
    async probeHost () { return { healthy: false } },
    async probeContainer () { return false },
    async restart () { restarts++; return '127.0.0.1:31002' },
    async restore () {},
    restoreInitially: true,
    onAddress () {},
    onState (state) { states.push(state) }
  })

  await monitor.checkNow()
  await monitor.checkNow()
  await monitor.checkNow()

  assert.equal(restarts, 0)
  assert.deepEqual(states.at(-1), { status: 'container-unhealthy' })
  await monitor.stop()
})

test('a successful host probe resets the consecutive failure count', async () => {
  const results = [false, false, true, false, false]
  const states: HostHealthState[] = []
  let restarts = 0
  const monitor = createHostHealthMonitor({
    getAddress: () => '127.0.0.1:31001',
    async probeHost () { return { healthy: results.shift() ?? true, configured: true } },
    async probeContainer () { return true },
    async restart () { restarts++; return '127.0.0.1:31002' },
    async restore () {},
    onAddress () {},
    onState (state) { states.push(state) }
  })

  for (let i = 0; i < 5; i++) await monitor.checkNow()

  assert.equal(restarts, 0)
  assert.deepEqual(states.at(-1), { status: 'host-unreachable', failureCount: 2, failureThreshold: 3 })
  await monitor.stop()
})

test('does not report recovery when the post-restart configuration restore fails', async () => {
  const states: HostHealthState[] = []
  let hostProbes = 0
  let restores = 0
  let now = 0
  const monitor = createHostHealthMonitor({
    getAddress: () => '127.0.0.1:31001',
    async probeHost () { hostProbes++; return { healthy: hostProbes >= 4, configured: hostProbes >= 4 ? false : undefined } },
    async probeContainer () { return true },
    async restart () { return '127.0.0.1:31002' },
    async restore () {
      restores++
      if (restores === 1) throw new Error('source configuration rejected')
    },
    onAddress () {},
    onState (state) { states.push(state) },
    recoveryCooldownMs: 100,
    now: () => now
  })

  await monitor.checkNow()
  await monitor.checkNow()
  await monitor.checkNow()

  assert.deepEqual(states.at(-1), { status: 'recovery-failed', error: 'source configuration rejected' })
  assert.equal(states.some((state) => state.status === 'recovered'), false)

  await monitor.checkNow()
  assert.deepEqual(states.at(-1), { status: 'recovery-failed', error: 'source configuration rejected' })
  assert.equal(restores, 1)

  now = 100
  await monitor.checkNow()
  assert.equal(restores, 2)
  assert.deepEqual(states.at(-1), { status: 'recovered' })
  await monitor.stop()
})

test('restores a healthy service that lost configuration in an out-of-band restart', async () => {
  let restores = 0
  let restarts = 0
  const states: HostHealthState[] = []
  const monitor = createHostHealthMonitor({
    getAddress: () => '127.0.0.1:31001',
    async probeHost () { return { healthy: true, configured: false } },
    async probeContainer () { return true },
    async restart () { restarts++; return '127.0.0.1:31002' },
    async restore () { restores++ },
    onAddress () {},
    onState (state) { states.push(state) }
  })

  await monitor.checkNow()

  assert.equal(restores, 1)
  assert.equal(restarts, 0)
  assert.deepEqual(states.at(-1), { status: 'recovered' })
  await monitor.stop()
})
