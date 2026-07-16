import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { extractContainerManifestDigests } from './container-manifest-contract.mjs'

const image = process.env.IMAGE
const imageDigest = process.env.IMAGE_DIGEST
assert.ok(image, 'IMAGE is required')
assert.match(imageDigest ?? '', /^sha256:[a-f0-9]{64}$/, 'IMAGE_DIGEST is invalid')

const manifest = JSON.parse(execFileSync('docker', [
  'buildx',
  'imagetools',
  'inspect',
  `${image}@${imageDigest}`,
  '--format',
  '{{json .Manifest}}'
], { encoding: 'utf8' }))
const digests = extractContainerManifestDigests(manifest)
assert.equal(digests.indexDigest, imageDigest, 'registry index digest does not match the built digest')

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `amd64_digest=${digests.amd64Digest}`,
    `arm64_digest=${digests.arm64Digest}`,
    ''
  ].join('\n'))
}

process.stdout.write(`Container platform manifests verified for ${image}@${imageDigest}.\n`)
