import { execFileSync } from 'node:child_process'
import { assertPackageFiles, parsePackReport } from './package-contract.mjs'

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8'
})
const report = parsePackReport(output)
const files = report.files.map((entry) => entry.path)
assertPackageFiles(files)

process.stdout.write(`Package contents verified: ${files.length} files, ${report.size} bytes.\n`)
