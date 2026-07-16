import assert from 'node:assert/strict'

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const SUPPORTED_ARCHITECTURES = ['amd64', 'arm64']

export function extractContainerManifestDigests (manifest) {
  assert.match(manifest?.digest ?? '', DIGEST_PATTERN, 'image index has no sha256 digest')
  assert.ok(Array.isArray(manifest?.manifests), 'image index has no platform manifests')

  const entries = manifest.manifests.map((entry) => ({
    architecture: entry.platform?.architecture,
    digest: entry.digest,
    os: entry.platform?.os
  }))
  assert.deepEqual(
    entries.map(({ architecture, os }) => `${os}/${architecture}`).sort(),
    SUPPORTED_ARCHITECTURES.map((architecture) => `linux/${architecture}`),
    'image index must contain exactly the supported Linux architectures'
  )

  const digests = Object.fromEntries(entries.map(({ architecture, digest }) => {
    assert.match(digest ?? '', DIGEST_PATTERN, `linux/${architecture} manifest has no sha256 digest`)
    return [architecture, digest]
  }))
  return {
    amd64Digest: digests.amd64,
    arm64Digest: digests.arm64,
    indexDigest: manifest.digest
  }
}
