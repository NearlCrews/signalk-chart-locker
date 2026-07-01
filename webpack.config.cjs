'use strict'

const path = require('node:path')
const webpack = require('webpack')
const pkg = require('./package.json')

// The Signal K admin UI looks up a configurator panel on window[<safeName>],
// so the Module Federation container name must be the package name with any
// non-word characters replaced.
const safeName = pkg.name.replace(/[-@/]/g, '_')

module.exports = {
  // No `entry`: this is a pure Module Federation remote. The admin UI loads
  // only remoteEntry.js and the exposed panel chunk, so a host entry bundle
  // would just be dead weight in the published tarball.
  entry: {},
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'public'),
    // remoteEntry.js keeps its fixed name (set on the plugin below) so the
    // admin UI can always find it; the panel chunk is content-hashed so a
    // changed build cannot be served stale from a browser cache.
    chunkFilename: '[name].[contenthash].js',
    // Wipe stale bundles and chunks on each build: public/ holds nothing but
    // this webpack output, so a renamed or removed chunk leaves no orphan.
    clean: true
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'babel-loader',
        exclude: /node_modules/,
        options: {
          presets: [
            ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
            ['@babel/preset-react', { runtime: 'automatic' }]
          ]
        }
      }
    ]
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
    // Resolve ESM-style ".js" specifiers onto sibling ".ts"/".tsx" sources, so
    // panel code can import the shared plugin modules with the same node16
    // ".js" import convention the Node build uses.
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js']
    }
  },
  plugins: [
    new webpack.container.ModuleFederationPlugin({
      name: safeName,
      // Classic "var" container: remoteEntry.js assigns the panel to the
      // global window[safeName], which is how the Signal K admin UI finds
      // configurator panels.
      library: { type: 'var', name: safeName },
      filename: 'remoteEntry.js',
      exposes: {
        // Expose the index module so its re-export is the federation surface
        // rather than dead code beside the panel.
        './PluginConfigurationPanel': './src/panel/index.tsx'
      },
      // The panel uses React hooks only; it never imports react-dom (the admin
      // UI host owns rendering), so only react is shared.
      shared: {
        react: { singleton: true, requiredVersion: '^19' }
      }
    })
  ]
}
