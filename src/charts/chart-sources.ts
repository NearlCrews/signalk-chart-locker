/** The one loader for the shared chart-source catalog. Chart Locker is a CommonJS Signal K plugin,
 * while chart-sources intentionally exposes an ESM-only runtime; the NodeNext build preserves this
 * dynamic import, which crosses that boundary. The import starts on first use rather than at module
 * load, so a failed import rejects in front of a caller that handles it instead of as a process-level
 * unhandled rejection, and every caller shares the one module promise. */

type ChartSourcesModule = typeof import('signalk-chart-sources')

let chartSources: Promise<ChartSourcesModule> | undefined

export async function loadChartSources (): Promise<ChartSourcesModule> {
  chartSources ??= import('signalk-chart-sources')
  return await chartSources
}
