import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import vm from 'node:vm'
import React from 'react'
import ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'

const publicDir = new URL('../public/', import.meta.url)
const stats = JSON.parse(readFileSync(new URL('../.panel-stats.json', import.meta.url), 'utf8'))
const bundles = readdirSync(publicDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, source: readFileSync(new URL(name, publicDir), 'utf8') }))

if (bundles.length === 0) throw new Error('panel build produced no JavaScript bundles')

function flattenModules (modules, flattened = []) {
  for (const module of modules ?? []) {
    flattened.push(module)
    flattenModules(module.modules, flattened)
  }
  return flattened
}

const modules = flattenModules(stats.modules)
const consumedHostReact = modules.some((module) =>
  module.moduleType === 'consume-shared-module' &&
  typeof module.name === 'string' &&
  module.name.includes('react@>=19.2.0 <20.0.0') &&
  module.name.includes('(singleton)')
)
if (!consumedHostReact) {
  throw new Error('webpack stats do not prove that the panel consumes singleton React from the host')
}

const normalizedModulePaths = modules
  .map((module) => typeof module.nameForCondition === 'string'
    ? module.nameForCondition.replaceAll('\\', '/')
    : null)
  .filter((modulePath) => modulePath !== null)

const expectedBundledPackages = new Set([
  'css-loader',
  'react',
  'signalk-nearlcrews-ui',
  'style-loader'
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

if (!normalizedModulePaths.some((modulePath) => modulePath.includes('/node_modules/signalk-nearlcrews-ui/dist/'))) {
  throw new Error('webpack stats do not prove that signalk-nearlcrews-ui is bundled into the remote')
}

const allowedReactModules = new Set([
  '/node_modules/react/jsx-runtime.js',
  '/node_modules/react/cjs/react-jsx-runtime.production.js'
])
const unexpectedReactModules = normalizedModulePaths.filter((modulePath) => {
  const reactIndex = modulePath.lastIndexOf('/node_modules/react/')
  if (reactIndex === -1) return false
  return !allowedReactModules.has(modulePath.slice(reactIndex))
})
if (unexpectedReactModules.length > 0) {
  throw new Error(`panel bundled unexpected React modules: ${[...new Set(unexpectedReactModules)].join(', ')}`)
}
if (normalizedModulePaths.some((modulePath) => modulePath.includes('/node_modules/react-dom/'))) {
  throw new Error('panel bundled react-dom instead of leaving rendering to the Signal K Admin host')
}

const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
for (const packageName of [...expectedBundledPackages, 'webpack']) {
  const packageMetadata = JSON.parse(readFileSync(
    new URL(`../node_modules/${packageName}/package.json`, import.meta.url),
    'utf8'
  ))
  if (!notices.includes(`\`${packageName}\` ${packageMetadata.version},`)) {
    throw new Error(`THIRD_PARTY_NOTICES.md does not identify bundled ${packageName} ${packageMetadata.version}`)
  }
}

const PANEL_GZIP_LIMIT_BYTES = 25 * 1024
const panelGzipBytes = bundles.reduce((total, { source }) => total + gzipSync(source, { level: 9 }).length, 0)
if (panelGzipBytes > PANEL_GZIP_LIMIT_BYTES) {
  throw new Error(`panel bundle is ${panelGzipBytes} gzip bytes; limit is ${PANEL_GZIP_LIMIT_BYTES}`)
}

for (const { name, source } of bundles) {
  if (source.includes('jsxDEV') || source.includes('jsx-dev-runtime')) {
    throw new Error(`${name} uses the React development JSX runtime`)
  }
}

const head = {
  appendChild: (node) => { node.parentNode = head },
  removeChild: (node) => { node.parentNode = null }
}
const document = {
  currentScript: {
    tagName: 'SCRIPT',
    src: 'http://localhost/plugins/signalk-chart-locker/remoteEntry.js'
  },
  head,
  querySelector: (selector) => selector === 'head' ? head : null,
  createElement: (tagName) => ({
    tagName: tagName.toUpperCase(),
    firstChild: null,
    parentNode: null,
    setAttribute: () => {},
    appendChild (node) {
      this.firstChild = node
      node.parentNode = this
    },
    removeChild (node) {
      if (this.firstChild === node) this.firstChild = null
      node.parentNode = null
    }
  }),
  createTextNode: (textContent) => ({ textContent, parentNode: null })
}

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  AbortSignal,
  URL,
  Intl,
  document,
  fetch: async () => { throw new Error('panel runtime check must not fetch during render') }
})
context.self = context
context.window = context
context.globalThis = context
context.CSSScopeRule = function CSSScopeRule () {}
context.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

// Evaluate chunks first so the remote runtime consumes their queued registrations without needing a
// browser document to fetch them. This exercises the same classic global container the admin UI uses.
for (const { name, source } of bundles.filter(({ name }) => name !== 'remoteEntry.js')) {
  vm.runInContext(source, context, { filename: name })
}
vm.runInContext(readFileSync(new URL('remoteEntry.js', publicDir), 'utf8'), context, {
  filename: 'remoteEntry.js'
})

const container = context.signalk_chart_locker
if (container === null || typeof container !== 'object') {
  throw new Error('panel remote did not expose the signalk_chart_locker container')
}

const shareEntry = (module, version) => ({
  [version]: {
    get: () => Promise.resolve(() => module),
    loaded: true,
    from: 'panel-runtime-check',
    eager: true,
    shareConfig: { singleton: true, requiredVersion: `^${version}` }
  }
})
await container.init({
  react: shareEntry(React, React.version),
  'react-dom': shareEntry(ReactDOM, ReactDOM.version)
})
const factory = await container.get('./PluginConfigurationPanel')
const panelModule = factory()
const markup = renderToStaticMarkup(React.createElement(panelModule.default, {
  configuration: { tileCache: { cacheCapGiB: 2, regionsBudgetGiB: 0 } },
  save: () => {}
}))
if (!markup.includes('Cache size cap')) throw new Error('panel runtime check did not render the configuration form')
if (!markup.includes('data-snui-version')) throw new Error('panel runtime check did not render signalk-nearlcrews-ui')

const combinedSource = bundles.map(({ source }) => source).join('\n')
for (const marker of [
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
  'react-dom.production.min'
]) {
  if (combinedSource.includes(marker)) {
    throw new Error(`panel bundle included a React implementation marker: ${marker}`)
  }
}

process.stdout.write(`Panel production runtime rendered across ${bundles.length} bundles with stats-verified host React and bundled signalk-nearlcrews-ui (${panelGzipBytes} gzip bytes).\n`)
