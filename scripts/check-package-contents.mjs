import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { assertPackageFiles, parsePackReport } from './package-contract.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (packageJson.dependencies?.['signalk-nearlcrews-ui'] !== undefined) {
  throw new Error('signalk-nearlcrews-ui must be a bundled development dependency')
}
// Two assertions, because either one alone has a hole. The shape rule is never hand-edited, so a
// range npm wrote for itself, say the ^0.9.0 an `npm install ...@latest` leaves behind, cannot be
// repaired by pasting the received value into the literal below, which would satisfy an equality
// check while stamping a range into every downstream consumer. The literal is the deliberate-bump
// tripwire that the shape rule on its own would let through.
const EXPECTED_SHARED_UI_VERSION = '0.8.2'
const pinnedSharedUi = packageJson.devDependencies?.['signalk-nearlcrews-ui']
if (typeof pinnedSharedUi !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinnedSharedUi)) {
  throw new Error(
    `signalk-nearlcrews-ui must be pinned to a bare exact version, found ${String(pinnedSharedUi)}`
  )
}
if (pinnedSharedUi !== EXPECTED_SHARED_UI_VERSION) {
  throw new Error(
    `signalk-nearlcrews-ui must be pinned to ${EXPECTED_SHARED_UI_VERSION}, found ${pinnedSharedUi}`
  )
}

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8'
})
const report = parsePackReport(output)
const files = report.files.map((entry) => entry.path)
assertPackageFiles(files)

for (const name of ['config-panel.png', 'config-panel-dark.png', 'config-panel-night.png']) {
  const image = readFileSync(new URL(`../assets/screenshots/${name}`, import.meta.url))
  if (
    image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    image.readUInt32BE(16) !== 1280 ||
    image.readUInt32BE(20) !== 800
  ) {
    throw new Error(`${name} must be a 1280 by 800 PNG`)
  }
}

process.stdout.write(`Package contents verified: ${files.length} files, ${report.size} bytes.\n`)
