import neostandard from 'neostandard'
import react from 'eslint-plugin-react'

export default [
  ...neostandard({
    ts: true,
    // .remember/ holds session-state TypeScript files that flat config would lint and error on, since flat config does not honor .gitignore.
    // public/ holds the webpack Module Federation output (remoteEntry.js and content-hashed chunks); it is a build artifact, not source.
    ignores: ['dist/', 'node_modules/', 'container/', 'public/', '.remember/']
  }),
  // The configurator panel is React. Scope the React rule set to it so the
  // Node plugin sources are unaffected.
  {
    ...react.configs.flat.recommended,
    files: ['src/panel/**/*.{ts,tsx}'],
    settings: { react: { version: 'detect' } }
  },
  {
    ...react.configs.flat['jsx-runtime'],
    files: ['src/panel/**/*.{ts,tsx}']
  }
]
