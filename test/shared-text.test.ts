import test from 'node:test'
import assert from 'node:assert/strict'
import { hasControlCharacter, normalizePrintableText } from '../src/shared/text.js'

test('printable text rejects C0, C1, and Unicode line separators before trimming', () => {
  for (const control of ['\n', '\u0085', '\u2028', '\u2029']) {
    assert.equal(hasControlCharacter(`before${control}after`), true)
    assert.equal(normalizePrintableText(` ${control}Area `, 120), undefined)
  }
})

test('printable text trims ordinary space and permits script joiners', () => {
  assert.equal(normalizePrintableText('  Area  ', 120), 'Area')
  assert.equal(normalizePrintableText('क्\u200dषेत्र', 120), 'क्\u200dषेत्र')
})
