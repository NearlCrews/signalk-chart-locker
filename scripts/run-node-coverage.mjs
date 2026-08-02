import { execFileSync } from 'node:child_process'
import { resolveNodeTests } from './node-test-suite.mjs'

// Coverage variant of run-node-tests.mjs: same suite, measured through the Node test runner's
// built-in V8 coverage. Thresholds sit a few points below the measured baseline (94.27 lines,
// 83.82 branches, 93.84 functions on 2026-08-02) so a coverage regression fails without flaking on
// a single new uncovered line. The threshold flags require Node 22.8; the runtime floor is 22.0,
// so on older Node the suite still runs with plain unfiltered, ungated coverage.
const { root, tests } = resolveNodeTests()

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const coverageFlagsSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 8)
if (!coverageFlagsSupported) {
  console.warn(`Node ${process.versions.node} predates 22.8: running coverage without include filters or thresholds`)
}
execFileSync(process.execPath, [
  '--import',
  'tsx',
  '--test',
  '--experimental-test-coverage',
  ...(coverageFlagsSupported
    ? [
        '--test-coverage-include=src/**/*.ts',
        '--test-coverage-include=src/**/*.tsx',
        '--test-coverage-lines=90',
        '--test-coverage-branches=80',
        '--test-coverage-functions=90'
      ]
    : []),
  ...tests
], {
  cwd: root,
  stdio: 'inherit'
})
