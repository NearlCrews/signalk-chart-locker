/** Pure decision logic for the off-plan position-warm: when the vessel travels outside the saved region,
 * keep a small radius around it warm, throttled and offline-aware. The Signal K read stays in the plugin;
 * this module decides, the caller performs the warm. */

import type { LngLatBbox } from 'signalk-chart-sources'
import type { Position } from '../shared/types.js'
import type { PositionWarmSettings, SavedRegion } from './regions-store.js'

export interface WarmTrigger {
  lastPos: Position | null
  lastWarmMs: number
  backoffUntilMs: number
}

/** Validate the live Signal K position before any geometry or distance calculation. */
export function isValidPosition (value: unknown): value is Position {
  if (typeof value !== 'object' || value === null) return false
  const position = value as Partial<Position>
  return typeof position.latitude === 'number' && Number.isFinite(position.latitude) &&
    typeof position.longitude === 'number' && Number.isFinite(position.longitude) &&
    position.latitude >= -90 && position.latitude <= 90 &&
    position.longitude >= -180 && position.longitude <= 180
}

/** Whether the position is within the box (a null box is never inside). */
export function insideBox (pos: Position, bbox: LngLatBbox | null): boolean {
  if (!Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) return false
  if (bbox === null) return false
  const longitudeInside = bbox[0] <= bbox[2]
    ? pos.longitude >= bbox[0] && pos.longitude <= bbox[2]
    : pos.longitude >= bbox[0] || pos.longitude <= bbox[2]
  return longitudeInside && pos.latitude >= bbox[1] && pos.latitude <= bbox[3]
}

/** Whether the position is inside any of the saved regions. An empty list is never inside. */
export function insideAnyRegion (pos: Position, regions: SavedRegion[]): boolean {
  return regions.some((r) => insideBox(pos, r.bbox))
}

const EARTH_RADIUS_M = 6_371_000

/** Great-circle distance in meters. */
export function haversineMeters (a: Position, b: Position): number {
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** A small bbox of `radiusMeters` around the position. Longitude degrees shrink with latitude. */
export function bboxAround (pos: Position, radiusMeters: number): LngLatBbox {
  const dLat = radiusMeters / 111_320
  const dLng = radiusMeters / (111_320 * Math.max(0.01, Math.cos((pos.latitude * Math.PI) / 180)))
  return [
    Math.max(-180, pos.longitude - dLng),
    Math.max(-90, pos.latitude - dLat),
    Math.min(180, pos.longitude + dLng),
    Math.min(90, pos.latitude + dLat)
  ]
}

/**
 * One or two world-bounded boxes around a position. A radius crossing the antimeridian is split so the
 * tile enumerator warms both sides of the date line without interpreting it as an almost-global box.
 */
export function bboxesAround (pos: Position, radiusMeters: number): LngLatBbox[] {
  const dLat = radiusMeters / 111_320
  const dLng = Math.min(180, radiusMeters / (111_320 * Math.max(0.01, Math.cos((pos.latitude * Math.PI) / 180))))
  const south = Math.max(-90, pos.latitude - dLat)
  const north = Math.min(90, pos.latitude + dLat)
  const west = pos.longitude - dLng
  const east = pos.longitude + dLng
  if (west < -180) {
    return [[west + 360, south, 180, north], [-180, south, east, north]]
  }
  if (east > 180) {
    return [[west, south, 180, north], [-180, south, east - 360, north]]
  }
  return [[west, south, east, north]]
}

/** The interval floor: a position-warm never fires more often than this, even if a persisted or
 * directly-posted config carries a smaller value. The config route floors it too. */
export const MIN_WARM_INTERVAL_SECS = 60

/** Decide whether to warm now: enabled, outside all regions, off backoff, past the interval, and moved
 * past the threshold, unless this is the first fix (lastPos is null). */
export function shouldWarm (pos: Position, regions: SavedRegion[], settings: PositionWarmSettings, trigger: WarmTrigger, nowMs: number): boolean {
  if (!isValidPosition(pos)) return false
  if (!settings.enabled) return false
  if (insideAnyRegion(pos, regions)) return false
  if (nowMs < trigger.backoffUntilMs) return false
  if (trigger.lastPos !== null) {
    const intervalMs = Math.max(MIN_WARM_INTERVAL_SECS, settings.intervalSecs) * 1000
    if (nowMs - trigger.lastWarmMs < intervalMs) return false
    if (haversineMeters(pos, trigger.lastPos) < settings.moveThresholdMeters) return false
  }
  return true
}
