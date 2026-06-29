// src/charts/chart-id.ts
/** The chart-resource id scheme: map "file.pmtiles" to "file-pmtiles", preserved from the
 * third-party signalk-pmtiles-plugin so a cutover does not reset webapp state keyed by chart id.
 * String.replace with a string pattern replaces only the first occurrence, matching the original. */
export function nameToId (fileName: string): string {
  return fileName.replace('.pmtiles', '-pmtiles')
}
