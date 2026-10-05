/**
 * Repository-specific checks on the built panel remote. The shared UI package's
 * `snui-check-consumer`, which `build:panel` runs next, covers the shared package contract, so this
 * script checks only the bundle's package inventory and that the notices file covers it.
 */
import { readFileSync } from 'node:fs'

const stats = JSON.parse(readFileSync(new URL('../.panel-stats.json', import.meta.url), 'utf8'))

function flattenModules (modules, flattened = []) {
  for (const module of modules ?? []) {
    flattened.push(module)
    flattenModules(module.modules, flattened)
  }
  return flattened
}

const normalizedModulePaths = flattenModules(stats.modules)
  .map((module) => typeof module.nameForCondition === 'string'
    ? module.nameForCondition.replaceAll('\\', '/')
    : null)
  .filter((modulePath) => modulePath !== null)

// React Aria arrives through the shared UI package, whose PanelRoot mounts an overlay portal
// provider, so it is bundled even though this panel imports no overlay entry point.
const expectedBundledPackages = new Set([
  'react',
  'react-aria',
  'signalk-nearlcrews-ui'
])
const bundledPackages = new Set(normalizedModulePaths
  .filter((modulePath) => modulePath.includes('/node_modules/'))
  .map((modulePath) => {
    const packagePath = modulePath.slice(modulePath.lastIndexOf('/node_modules/') + '/node_modules/'.length)
    const [first, second] = packagePath.split('/')
    return first.startsWith('@') ? `${first}/${second}` : first
  }))
const unexpectedPackages = [...bundledPackages].filter((name) => !expectedBundledPackages.has(name))
const missingPackages = [...expectedBundledPackages].filter((name) => !bundledPackages.has(name))
if (unexpectedPackages.length > 0 || missingPackages.length > 0) {
  throw new Error(`panel dependency inventory changed; unexpected: ${unexpectedPackages.join(', ') || 'none'}; missing: ${missingPackages.join(', ') || 'none'}`)
}

// The notices file is generated from webpack's own module list and its license texts are verified by
// scripts/generate-third-party-notices.mjs --check. What that check cannot see is this script's
// independently maintained inventory, so cross-check the two: every package the panel is allowed to
// bundle must have a section in the notices, which catches an inventory widened without regenerating.
const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
const noticedPackages = new Set(
  [...notices.matchAll(/^## (\S+)$/gm)].map((match) => match[1])
)
for (const packageName of [...expectedBundledPackages, 'webpack']) {
  if (!noticedPackages.has(packageName)) {
    throw new Error(`THIRD_PARTY_NOTICES.md has no section for bundled ${packageName}; run npm run licenses`)
  }
}

process.stdout.write(`Panel bundle holds the expected ${expectedBundledPackages.size} packages, each covered by the notices.\n`)
