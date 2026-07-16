const REQUIRED_PACKAGE_FILES = [
  'dist/index.js',
  'dist/index.d.ts',
  'public/remoteEntry.js',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE-APACHE',
  'RUST_THIRD_PARTY_LICENSES.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'docs/API.md',
  'docs/OPERATIONS.md'
]
const ALLOWED_PACKAGE_FILES = new Set([
  ...REQUIRED_PACKAGE_FILES.filter((path) => !path.startsWith('dist/') && !path.startsWith('public/'))
])
const ALLOWED_PACKAGE_PREFIXES = ['assets/', 'dist/', 'public/']

export function assertPackageFiles (packageFiles) {
  const files = new Set(packageFiles)
  if (files.size !== packageFiles.length) throw new Error('package contains duplicate paths')

  for (const path of files) {
    const components = path.split('/')
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      components.some((component) => component === '' || component === '.' || component === '..')
    ) {
      throw new Error(`package contains an unsafe path: ${path}`)
    }
  }

  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!files.has(required)) throw new Error(`package is missing ${required}`)
  }

  for (const path of files) {
    const allowed = ALLOWED_PACKAGE_FILES.has(path) || ALLOWED_PACKAGE_PREFIXES.some((prefix) => path.startsWith(prefix))
    if (!allowed) throw new Error(`package contains path outside the publication allowlist: ${path}`)
    if (path.startsWith('dist/bridge/') || path.includes('prewarm') || path.includes('route-draft')) {
      throw new Error(`package contains retired output: ${path}`)
    }
  }
}

export function parsePackReport (output) {
  const jsonStart = output.search(/^\s*(?:\[|{)/m)
  if (jsonStart === -1) throw new Error('npm pack did not return a JSON report')
  const parsed = JSON.parse(output.slice(jsonStart))
  let reports = []
  if (Array.isArray(parsed)) reports = parsed
  else if (parsed !== null && typeof parsed === 'object') reports = Object.values(parsed)
  if (reports.length !== 1) {
    throw new Error(`npm pack returned ${reports.length} reports`)
  }
  return reports[0]
}
