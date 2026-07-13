import { readFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'
import React from 'react'
import ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'

const publicDir = new URL('../public/', import.meta.url)
const bundles = readdirSync(publicDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, source: readFileSync(new URL(name, publicDir), 'utf8') }))

if (bundles.length === 0) throw new Error('panel build produced no JavaScript bundles')

for (const { name, source } of bundles) {
  if (source.includes('jsxDEV') || source.includes('jsx-dev-runtime')) {
    throw new Error(`${name} uses the React development JSX runtime`)
  }
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
  document: {
    currentScript: {
      tagName: 'SCRIPT',
      src: 'http://localhost/plugins/signalk-chart-locker/remoteEntry.js'
    }
  },
  fetch: async () => { throw new Error('panel runtime check must not fetch during render') }
})
context.self = context
context.window = context
context.globalThis = context
context.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
context.confirm = () => false

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

process.stdout.write(`Panel production runtime rendered across ${bundles.length} bundles.\n`)
