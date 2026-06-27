import neostandard from 'neostandard'

export default neostandard({
  ts: true,
  // .remember/ holds session-state TypeScript files that flat config would lint and error on, since flat config does not honor .gitignore.
  ignores: ['dist/', 'node_modules/', 'container/', '.remember/']
})
