import { execFileSync } from 'node:child_process'
import { resolveNodeTests } from './node-test-suite.mjs'

const { root, tests } = resolveNodeTests()
execFileSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
  cwd: root,
  stdio: 'inherit'
})
