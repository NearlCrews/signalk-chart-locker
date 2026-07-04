/** Stable identity constants for the plugin, imported wherever the id or name is needed. */

export const PLUGIN_ID = 'signalk-chart-locker'
export const PLUGIN_NAME = 'Chart Locker'
/** The Signal K mount prefix for this plugin's HTTP routes: `/plugins/<id>`. Derived from PLUGIN_ID so
 * a rename cannot leave a stale hardcoded literal behind (this repo has already renamed once). */
export const PLUGIN_MOUNT_PATH = `/plugins/${PLUGIN_ID}`
export const PLUGIN_DESCRIPTION =
  'Signal K plugin that runs a Rust container alongside the server for a boat-wide tile cache, a PMTiles chart provider, and saved downloadable map regions.'
export const PLUGIN_REPO_URL = 'https://github.com/NearlCrews/signalk-chart-locker'
