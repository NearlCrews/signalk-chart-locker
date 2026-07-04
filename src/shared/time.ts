/** Time helpers shared across the plugin so the same clock idiom is not rewritten per call site. */

/** The current time as whole Unix seconds, the resolution the regions store and its routes persist. */
export function nowUnixSecs (): number {
  return Math.floor(Date.now() / 1000)
}
