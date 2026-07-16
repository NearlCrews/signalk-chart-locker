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
        test: /\.module\.css$/,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              modules: {
                localIdentName: 'cl-[local]-[hash:base64:5]',
                namedExport: false
              }
            }
          }
        ]
      },
      {
        test: /\.tsx?$/,
        loader: 'babel-loader',
        exclude: /node_modules/,
        options: {
          presets: [
            // Babel 8 detects JSX from the file extension (.tsx enables it,
            // .ts does not), so the old isTSX/allExtensions options are gone.
            '@babel/preset-typescript',
            // Pin the production JSX runtime. Babel 8 otherwise emits jsxDEV when NODE_ENV is
            // unset, even under webpack production mode. The Signal K React 19 share scope exposes
            // the production runtime, so jsxDEV would be undefined when the panel loads.
            ['@babel/preset-react', { runtime: 'automatic', development: false }]
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
        react: {
          singleton: true,
          requiredVersion: '>=19.2.0 <20.0.0',
          import: false
        }
      }
    })
  ]
}
