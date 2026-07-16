import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export function findReleaseArtifacts (fileNames) {
  const tarballs = fileNames.filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `expected one release tarball, found ${tarballs.length}`)
  const tarball = tarballs[0]
  const checksum = `${tarball}.sha256`
  assert.deepEqual(
    [...fileNames].sort(),
    [tarball, checksum].sort(),
    'release package directory must contain only the tarball and its checksum'
  )
  return { checksum, tarball }
}

export function packagePathFromTarEntry (entry) {
  assert.match(entry, /^package\/.+/, `release tarball entry is outside the package root: ${entry}`)
  const path = entry.slice('package/'.length)
  assert.ok(
    !path.split('/').some((component) => component === '.' || component === '..') && !path.includes('\\'),
    `release tarball entry has an unsafe path: ${entry}`
  )
  return path
}

export function parseChecksum (checksum) {
  const match = checksum.trim().match(/^([a-f0-9]{64}) {2}([^/]+\.tgz)$/)
  assert.ok(match, 'release checksum file has an invalid format')
  return { digest: match[1], fileName: match[2] }
}

export function verifyChecksum (contents, expectedDigest) {
  const digest = createHash('sha256').update(contents).digest('hex')
  assert.equal(digest, expectedDigest, 'release tarball checksum does not match')
  return digest
}
