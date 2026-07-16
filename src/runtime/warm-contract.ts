/** Shared validation for the warm-job HTTP contract returned by the managed tilecache container. */

import { hasControlCharacter } from '../shared/text.js'

export type WarmState = 'running' | 'done' | 'cancelled' | 'capped' | 'error'

export interface WarmSnapshot {
  total: number
  done: number
  skipped: number
  bytes: number
  errors: number
  state: WarmState
}

export interface WarmJobSnapshot extends WarmSnapshot {
  jobId: string
}

const WARM_STATES = new Set<WarmState>(['running', 'done', 'cancelled', 'capped', 'error'])
const WARM_JOB_ID_RE = /^warm-[0-9a-f]{32}-([0-9]{1,20})$/
const U64_MAX = 18_446_744_073_709_551_615n

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonnegativeInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function validWarmJobId (value: unknown): value is string {
  if (typeof value !== 'string' || hasControlCharacter(value)) return false
  const match = WARM_JOB_ID_RE.exec(value)
  return match !== null && BigInt(match[1]!) <= U64_MAX
}

export function isWarmSnapshot (value: unknown): value is WarmSnapshot {
  if (!isRecord(value) || typeof value.state !== 'string' || !WARM_STATES.has(value.state as WarmState)) return false
  const { total, done, skipped, bytes, errors } = value
  if (!isNonnegativeInteger(total) || !isNonnegativeInteger(done) || !isNonnegativeInteger(skipped) ||
      !isNonnegativeInteger(bytes) || !isNonnegativeInteger(errors)) return false
  if (done > total || skipped > total || done > total - skipped) return false
  return value.state !== 'done' || done === total - skipped
}

export function isWarmJobSnapshot (value: unknown): value is WarmJobSnapshot {
  return isRecord(value) && isWarmSnapshot(value) && validWarmJobId(value.jobId)
}
