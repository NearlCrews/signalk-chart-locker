/** Which catalog sources may be downloaded ahead of time. The shared catalog marks a time-dynamic
 * source with `maxAgeSeconds`: its tiles expire on a timer, so storing them in advance fills the cache
 * with weather frames that are already wrong by the time anyone sails into them. The container refuses
 * to warm such a source, so the plugin must not offer or send one, otherwise a selection made entirely
 * of them produces a rejected job the caller cannot distinguish from an outage. */

import type { ChartSource } from 'signalk-chart-sources'

/** Resolve a catalog id, matching the shape of the package `chartSourceById`. */
export type SourceLookup = (id: string) => ChartSource | undefined

/** Whether the catalog declares a tile lifetime for this source. */
export function isTimeDynamicSource (source: ChartSource): boolean {
  return source.maxAgeSeconds !== undefined
}

/** Whether this source may be stored ahead of time. */
export function isWarmableSource (source: ChartSource): boolean {
  return !isTimeDynamicSource(source)
}

/** The given ids narrowed to the ones a warm will actually store, in the order they were given.
 * An id absent from the catalog is dropped too: the container rejects the whole job for one unknown id. */
export function warmableSourceIds (ids: readonly string[], lookup: SourceLookup): string[] {
  return ids.filter((id) => {
    const source = lookup(id)
    return source !== undefined && isWarmableSource(source)
  })
}

/** The given ids narrowed to the time-dynamic ones, so a caller can name them in its own rejection. */
export function timeDynamicSourceIds (ids: readonly string[], lookup: SourceLookup): string[] {
  return ids.filter((id) => {
    const source = lookup(id)
    return source !== undefined && isTimeDynamicSource(source)
  })
}
