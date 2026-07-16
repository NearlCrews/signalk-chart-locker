import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackageFiles, parsePackReport } from './package-contract.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outputDirectory = resolve(root, 'package')
rmSync(outputDirectory, { force: true, recursive: true })
mkdirSync(outputDirectory, { recursive: true })

const output = execFileSync('npm', [
  'pack',
  '--ignore-scripts',
  '--json',
  '--pack-destination',
  outputDirectory
], { cwd: root, encoding: 'utf8' })
const report = parsePackReport(output)
assertPackageFiles(report.files.map((entry) => entry.path))

const tarball = resolve(outputDirectory, basename(report.filename))
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`)

process.stdout.write(`Release tarball created: ${tarball} (sha256:${digest}).\n`)
