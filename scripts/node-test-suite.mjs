import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The single definition of the Node test suite: every test file under test/, except the Node-Rust
// contract test, which needs a built container binary and runs via test:node-rust-contract. Both
// run-node-tests.mjs and run-node-coverage.mjs consume this so the test gate and the coverage gate
// always measure the same suite.
export function resolveNodeTests () {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const testDirectory = resolve(root, 'test')
  const tests = readdirSync(testDirectory)
    .filter((name) => /\.test\.(?:mjs|ts)$/.test(name) && name !== 'node-rust-contract.test.ts')
    .sort()
    .map((name) => resolve(testDirectory, name))
  assert.ok(tests.length > 0, 'no Node tests were found')
  return { root, tests }
}
