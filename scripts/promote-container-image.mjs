import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { buildImagetoolsPromotionArgs } from './container-promotion-contract.mjs'
import { validateTagPromotion } from './release-policy.mjs'

const image = process.env.IMAGE
const imageDigest = process.env.IMAGE_DIGEST
const finalTags = process.env.FINAL_TAGS?.split('\n').filter(Boolean) ?? []
assert.ok(image, 'IMAGE is required')
assert.match(imageDigest ?? '', /^sha256:[a-f0-9]{64}$/, 'IMAGE_DIGEST is invalid')
assert.ok(finalTags.length > 0, 'FINAL_TAGS must contain at least one tag')

const promotions = []
for (const tag of finalTags) {
  assert.ok(tag.startsWith(`${image}:`), `release tag is outside the expected image: ${tag}`)
  const inspection = spawnSync('docker', [
    'buildx',
    'imagetools',
    'inspect',
    tag,
    '--format',
    '{{.Manifest.Digest}}'
  ], { encoding: 'utf8' })
  if (inspection.error) throw inspection.error

  let existingDigest = inspection.stdout.trim()
  if (inspection.status !== 0) {
    const details = `${inspection.stdout}\n${inspection.stderr}`.trim()
    assert.match(
      details,
      /(?:manifest unknown|not found)/i,
      `could not verify whether ${tag} already exists`
    )
    existingDigest = ''
  } else {
    assert.match(existingDigest, /^sha256:[a-f0-9]{64}$/, `registry returned an invalid digest for ${tag}`)
  }

  if (validateTagPromotion({ image, tag, existingDigest, releaseDigest: imageDigest })) promotions.push(tag)
}

if (promotions.length > 0) {
  execFileSync(
    'docker',
    buildImagetoolsPromotionArgs({ image, imageDigest, tags: promotions }),
    { stdio: 'inherit' }
  )
}

process.stdout.write(`Promoted tested image ${image}@${imageDigest} to ${finalTags.join(', ')}.\n`)
