import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_CAP_MAX_GIB,
  CACHE_CAP_MIN_GIB,
  deriveDefaultCapGiB,
  floorToStep,
  snapToStep
} from '../src/shared/cache-cap.js'

test('floorToStep rounds down to the nearest multiple of the step', () => {
  assert.equal(floorToStep(37, 5), 35)
  assert.equal(floorToStep(35, 5), 35)
  assert.equal(floorToStep(5, 5), 5)
  assert.equal(floorToStep(4, 5), 0)
})

test('floorToStep guards non-finite input and a non-positive step', () => {
  assert.equal(floorToStep(Number.NaN, 5), 0)
  assert.equal(floorToStep(100, 0), 0)
})

test('snapToStep rounds to the nearest multiple of the step', () => {
  assert.equal(snapToStep(8, 5), 10)
  assert.equal(snapToStep(7, 5), 5)
  assert.equal(snapToStep(12, 5), 10)
  assert.equal(snapToStep(13, 5), 15)
  assert.equal(snapToStep(Number.NaN, 5), 0)
})

test('deriveDefaultCapGiB takes 80 percent of free space, floored to the step', () => {
  assert.equal(deriveDefaultCapGiB(20), 16) // 20 * 0.8 = 16, already on the 4 GiB grid
  assert.equal(deriveDefaultCapGiB(30), 24) // 30 * 0.8 = 24
})

test('deriveDefaultCapGiB clamps a large disk to the maximum', () => {
  assert.equal(deriveDefaultCapGiB(120), CACHE_CAP_MAX_GIB) // 96 floored, clamped to 32
  assert.equal(deriveDefaultCapGiB(1000), CACHE_CAP_MAX_GIB)
})

test('deriveDefaultCapGiB never returns below the minimum', () => {
  assert.equal(deriveDefaultCapGiB(1), CACHE_CAP_MIN_GIB) // 0.8 floored to 0, clamped to 4
  assert.equal(deriveDefaultCapGiB(0), CACHE_CAP_MIN_GIB)
  assert.equal(deriveDefaultCapGiB(Number.NaN), CACHE_CAP_MIN_GIB)
})
