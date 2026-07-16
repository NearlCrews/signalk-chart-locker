import assert from 'node:assert/strict'

export function buildImagetoolsPromotionArgs ({ image, imageDigest, tags }) {
  assert.ok(image, 'image is required')
  assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/, 'image digest is invalid')
  assert.ok(Array.isArray(tags) && tags.length > 0, 'promotion tags must not be empty')
  return [
    'buildx',
    'imagetools',
    'create',
    ...tags.flatMap((tag) => ['--tag', tag]),
    `${image}@${imageDigest}`
  ]
}
