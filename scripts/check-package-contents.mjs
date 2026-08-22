import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { assertPackageFiles, parsePackReport } from './package-contract.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (packageJson.dependencies?.['signalk-nearlcrews-ui'] !== undefined) {
  throw new Error('signalk-nearlcrews-ui must be a bundled development dependency')
}
if (packageJson.devDependencies?.['signalk-nearlcrews-ui'] !== '0.8.1') {
  throw new Error('signalk-nearlcrews-ui must be pinned to exact version 0.8.1')
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
