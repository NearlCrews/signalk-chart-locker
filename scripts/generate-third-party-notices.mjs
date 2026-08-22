import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * The configuration panel is a Module Federation remote, so webpack inlines its dependency tree into
 * public/*.js and the published package redistributes that code. MIT requires the copyright and
 * permission notice to travel with a copy, and Apache-2.0 section 4(a) requires giving recipients the
 * license. Terser extracts only comments carrying an @license or @preserve marker and most of this
 * tree ships none, so the emitted banner alone discharges neither obligation.
 *
 * Nothing else in the package needs an entry here. The Node plugin under dist/ is plain compiled
 * TypeScript whose runtime dependencies reach the user through npm with their own licenses intact,
 * and the Rust container's locked graph is reported separately in RUST_THIRD_PARTY_LICENSES.md.
 *
 * Run `npm run licenses` to regenerate. `--check` verifies the committed file still matches the
 * installed tree without paying for a second webpack build.
 */

const repositoryDir = new URL('../', import.meta.url)
const noticesUrl = new URL('THIRD_PARTY_NOTICES.md', repositoryDir)
const checkOnly = process.argv.includes('--check')

const HEADER_MARKER = '<!-- generated-for-signalk-nearlcrews-ui:'

function installedVersion (name) {
  const manifest = JSON.parse(
    readFileSync(new URL(`node_modules/${name}/package.json`, repositoryDir), 'utf8')
  )
  return manifest.version
}

const sharedUiVersion = installedVersion('signalk-nearlcrews-ui')

/**
 * webpack's own module and federation runtime is emitted into every chunk without appearing as a
 * node_modules module, so asking the stats alone would under-report the one package that is present
 * in literally every bundle.
 */
const ALWAYS_EMITTED = ['webpack']

/** Ask webpack which packages it actually bundles, rather than guessing from the dependency list. */
function bundledPackageNames () {
  const result = spawnSync(
    process.execPath,
    ['node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.config.cjs', '--json'],
    { cwd: repositoryDir.pathname, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
  )
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '')
    throw new Error('webpack did not produce a module list')
  }
  const stats = JSON.parse(result.stdout)
  const names = new Set(ALWAYS_EMITTED)
  const walk = (modules) => {
    for (const module of modules ?? []) {
      const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec((module.nameForCondition ?? module.name ?? '').replaceAll('\\', '/'))
      if (match?.[1] !== undefined) names.add(match[1])
      walk(module.modules)
    }
  }
  walk(stats.modules)
  return [...names].sort()
}

function licenseTextFor (name) {
  for (const candidate of ['LICENSE', 'license', 'LICENSE.md', 'LICENSE.txt', 'LICENCE']) {
    const url = new URL(`node_modules/${name}/${candidate}`, repositoryDir)
    if (existsSync(url)) return readFileSync(url, 'utf8').trim()
  }
  return null
}

function licenseIdFor (name) {
  const manifest = JSON.parse(
    readFileSync(new URL(`node_modules/${name}/package.json`, repositoryDir), 'utf8')
  )
  return typeof manifest.license === 'string' ? manifest.license : 'see below'
}

function render (names) {
  const sections = names.map((name) => {
    const id = licenseIdFor(name)
    const text = licenseTextFor(name)
    const body = text === null
      ? `This package ships no license file. Its manifest declares ${id}.`
      : `\`\`\`text\n${text}\n\`\`\``
    return `## ${name}\n\nLicense: ${id}\n\n${body}`
  })
  return [
    '# Third-party notices',
    '',
    `${HEADER_MARKER}${sharedUiVersion} -->`,
    '',
    // One element per PARAGRAPH, not per source line: the join below puts a blank line between
    // elements, so a line-per-element shape would render every wrapped line as its own paragraph.
    'The configuration panel is a Module Federation remote, so the packages below are bundled into ' +
      '`public/*.js` and redistributed with this plugin. Their licenses follow. Regenerate with ' +
      '`npm run licenses` after any change to the panel dependency tree.',
    'React and React DOM are supplied by the Signal K admin host as singletons and are not bundled ' +
      'here; the React entry that does appear is the production JSX runtime. React Aria arrives ' +
      'through the shared UI package, whose PanelRoot mounts an overlay portal provider, so it is ' +
      'redistributed even though this panel imports no focused entry point.',
    'The Node plugin under `dist/` bundles nothing: its runtime dependencies reach the user through ' +
      'npm with their own licenses intact. The Rust tile-cache container reports its locked ' +
      'dependency graph separately in `RUST_THIRD_PARTY_LICENSES.md`.',
    ...sections
  ]
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
}

if (checkOnly) {
  if (!existsSync(noticesUrl)) {
    throw new Error('THIRD_PARTY_NOTICES.md is missing; run npm run licenses')
  }
  const current = readFileSync(noticesUrl, 'utf8')
  if (!current.includes(`${HEADER_MARKER}${sharedUiVersion} -->`)) {
    throw new Error(
      `THIRD_PARTY_NOTICES.md was generated for a different signalk-nearlcrews-ui than ${sharedUiVersion}; run npm run licenses`
    )
  }
  // Every package the file names must still resolve with the license it claims, which catches a
  // relicense or a removal without paying for a webpack build.
  const listed = [...current.matchAll(/^## (\S+)$/gm)].map((match) => match[1])
  if (listed.length === 0) throw new Error('THIRD_PARTY_NOTICES.md lists no packages')
  for (const name of listed) {
    if (!existsSync(new URL(`node_modules/${name}/package.json`, repositoryDir))) {
      throw new Error(`THIRD_PARTY_NOTICES.md names ${name}, which is no longer installed`)
    }
    const declared = licenseIdFor(name)
    if (!current.includes(`## ${name}\n\nLicense: ${declared}\n`)) {
      throw new Error(`${name} now declares ${declared}; run npm run licenses`)
    }
  }
  process.stdout.write(`Third-party notices cover ${listed.length} bundled packages.\n`)
} else {
  const names = bundledPackageNames()
  if (names.length === 0) throw new Error('webpack reported no bundled packages')
  writeFileSync(noticesUrl, `${render(names)}\n`)
  process.stdout.write(`Wrote THIRD_PARTY_NOTICES.md for ${names.length} bundled packages.\n`)
}
