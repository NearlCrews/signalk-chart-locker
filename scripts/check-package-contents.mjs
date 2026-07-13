import { execFileSync } from 'node:child_process'

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8'
})
const report = JSON.parse(output)[0]
const files = new Set(report.files.map((entry) => entry.path))

for (const required of [
  'dist/index.js',
  'dist/index.d.ts',
  'public/remoteEntry.js',
  'README.md',
  'CHANGELOG.md',
  'docs/API.md',
  'docs/OPERATIONS.md'
]) {
  if (!files.has(required)) throw new Error(`package is missing ${required}`)
}

for (const path of files) {
  if (path.startsWith('dist/bridge/') || path.includes('prewarm') || path.includes('route-draft')) {
    throw new Error(`package contains retired output: ${path}`)
  }
}

process.stdout.write(`Package contents verified: ${files.size} files, ${report.size} bytes.\n`)
