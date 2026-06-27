/** Signal K plugin entrypoint. All wiring lives in the plugin factory. */

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { createPlugin } from './plugin/plugin.js'

export = function (app: ServerAPI): Plugin {
  return createPlugin(app)
}
