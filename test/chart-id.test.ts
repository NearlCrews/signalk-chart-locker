// test/chart-id.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nameToId } from '../src/charts/chart-id.js'

test('nameToId maps a .pmtiles filename to its resource id', () => {
  assert.equal(nameToId('sf-bay.pmtiles'), 'sf-bay-pmtiles')
})

test('nameToId replaces only the first .pmtiles occurrence, preserving the third-party scheme', () => {
  assert.equal(nameToId('a.pmtiles.pmtiles'), 'a-pmtiles.pmtiles')
})
