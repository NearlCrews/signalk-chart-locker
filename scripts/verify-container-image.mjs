import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { extractContainerManifestDigests } from './container-manifest-contract.mjs'

const image = process.env.IMAGE
const imageTag = process.env.IMAGE_TAG
const expectedRevision = process.env.EXPECTED_REVISION
const expectedVersion = process.env.EXPECTED_VERSION
const repository = process.env.GITHUB_REPOSITORY

assert.ok(image, 'IMAGE is required')
assert.ok(imageTag, 'IMAGE_TAG is required')
assert.ok(expectedRevision, 'EXPECTED_REVISION is required')
assert.ok(expectedVersion, 'EXPECTED_VERSION is required')
assert.ok(repository, 'GITHUB_REPOSITORY is required')

const reference = `${image}:${imageTag}`
const manifest = JSON.parse(execFileSync('docker', [
  'buildx',
  'imagetools',
  'inspect',
  reference,
  '--format',
  '{{json .Manifest}}'
], { encoding: 'utf8' }))
const digests = extractContainerManifestDigests(manifest)

const expectedLabels = {
  'org.opencontainers.image.revision': expectedRevision,
  'org.opencontainers.image.source': `https://github.com/${repository}`,
  'org.opencontainers.image.version': expectedVersion
}
for (const architecture of ['amd64', 'arm64']) {
  const platformReference = `${image}@${digests[`${architecture}Digest`]}`
  execFileSync('docker', ['pull', '--platform', `linux/${architecture}`, platformReference], { stdio: 'inherit' })
  const labels = JSON.parse(execFileSync('docker', [
    'image',
    'inspect',
    platformReference,
    '--format',
    '{{json .Config.Labels}}'
  ], { encoding: 'utf8' }))
  for (const [label, expected] of Object.entries(expectedLabels)) {
    assert.equal(labels?.[label], expected, `${architecture} image label ${label} does not match`)
  }
  const healthcheck = JSON.parse(execFileSync('docker', [
    'image',
    'inspect',
    platformReference,
    '--format',
    '{{json .Config.Healthcheck}}'
  ], { encoding: 'utf8' }))
  assert.deepEqual(
    healthcheck?.Test,
    ['CMD', '/tilecache', 'healthcheck'],
    `${architecture} image has an unexpected health check`
  )
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `digest=${digests.indexDigest}`,
    `amd64_digest=${digests.amd64Digest}`,
    `arm64_digest=${digests.arm64Digest}`,
    ''
  ].join('\n'))
}
process.stdout.write(`Container image verified: ${reference}@${digests.indexDigest} (linux/amd64, linux/arm64).\n`)
