import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureApiAdminGate } from '../src/shared/admin-gate.js'
import type { ServerAPI } from '@signalk/server-api'

function fakeApp (withSecurity: boolean): { app: ServerAPI, gated: string[] } {
  const gated: string[] = []
  const app = {
    error: () => {},
    ...(withSecurity ? { securityStrategy: { addAdminMiddleware: (p: string) => gated.push(p) } } : {})
  } as unknown as ServerAPI
  return { app, gated }
}

test('the gate installs the admin middleware once and reports true', () => {
  const { app, gated } = fakeApp(true)
  assert.equal(ensureApiAdminGate(app), true)
  assert.equal(ensureApiAdminGate(app), true)
  assert.deepEqual(gated, ['/plugins/signalk-binnacle-companion/api'], 'installed exactly once')
})

test('the gate fails closed when no security strategy is present', () => {
  const { app } = fakeApp(false)
  assert.equal(ensureApiAdminGate(app), false)
})
