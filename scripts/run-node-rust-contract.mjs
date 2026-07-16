import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
assert.ok(process.env.TILECACHE_BIN, 'TILECACHE_BIN must identify the built release tilecache binary')

execFileSync(process.execPath, [
  '--import',
  'tsx',
  '--test',
  resolve(root, 'test/node-rust-contract.test.ts')
], { cwd: root, stdio: 'inherit' })
