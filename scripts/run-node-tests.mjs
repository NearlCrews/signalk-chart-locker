import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const testDirectory = resolve(root, 'test')
const tests = readdirSync(testDirectory)
  .filter((name) => /\.test\.(?:mjs|ts)$/.test(name) && name !== 'node-rust-contract.test.ts')
  .sort()
  .map((name) => resolve(testDirectory, name))

assert.ok(tests.length > 0, 'no Node tests were found')
execFileSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
  cwd: root,
  stdio: 'inherit'
})
