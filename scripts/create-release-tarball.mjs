import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackageFiles, parsePackReport } from './package-contract.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outputDirectory = resolve(root, 'package')
const packagePath = resolve(root, 'package.json')
const originalPackage = readFileSync(packagePath, 'utf8')
const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/.test(gitHead)) throw new Error('release checkout must resolve to a full Git commit')
rmSync(outputDirectory, { force: true, recursive: true })
mkdirSync(outputDirectory, { recursive: true })

let output
try {
  const manifest = JSON.parse(originalPackage)
  writeFileSync(packagePath, `${JSON.stringify({ ...manifest, gitHead }, null, 2)}\n`)
  output = execFileSync('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    outputDirectory
  ], { cwd: root, encoding: 'utf8' })
} finally {
  writeFileSync(packagePath, originalPackage)
}
const report = parsePackReport(output)
assertPackageFiles(report.files.map((entry) => entry.path))

const tarball = resolve(outputDirectory, basename(report.filename))
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`)

process.stdout.write(`Release tarball created with gitHead ${gitHead}: ${tarball} (sha256:${digest}).\n`)
