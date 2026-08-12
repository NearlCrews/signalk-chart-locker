import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export function normalizeNpmViewScalar (value, fieldName) {
  const values = Array.isArray(value) ? value : [value]
  assert.equal(values.length, 1, `npm view ${fieldName} must return exactly one value`)
  assert.equal(typeof values[0], 'string', `npm view ${fieldName} must return a string`)
  const normalized = values[0].trim()
  assert.notEqual(normalized, '', `npm view ${fieldName} must not return an empty string`)
  return normalized
}

export function parseNpmViewScalar (output, fieldName) {
  let value
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error(`npm view ${fieldName} did not return valid JSON`)
  }
  return normalizeNpmViewScalar(value, fieldName)
}

export function tarballIntegrity (contents) {
  return `sha512-${createHash('sha512').update(contents).digest('base64')}`
}

export function assertNpmRegistryContract ({
  actualGitHead,
  actualIntegrity,
  expectedGitHead,
  expectedIntegrity
}) {
  assert.match(expectedGitHead, /^[0-9a-f]{40}$/, 'expected gitHead must be a full Git commit')
  assert.match(expectedIntegrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'expected tarball integrity must be SHA-512 SRI')
  assert.equal(actualGitHead, expectedGitHead, 'registry gitHead does not match the release commit')
  assert.equal(actualIntegrity, expectedIntegrity, 'registry dist.integrity does not match the exact release tarball')
}
