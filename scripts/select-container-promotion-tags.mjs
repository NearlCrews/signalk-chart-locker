import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { selectMonotonicPromotionTags } from './release-policy.mjs'

const image = process.env.IMAGE
const version = process.env.RELEASE_VERSION
const candidateTags = process.env.CANDIDATE_TAGS?.split('\n').filter(Boolean) ?? []
assert.ok(image, 'IMAGE is required')
assert.ok(version, 'RELEASE_VERSION is required')

const repositoryTags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
const selectedTags = selectMonotonicPromotionTags({ candidateTags, image, repositoryTags, version })
const latest = `${image}:latest`
const output = process.env.GITHUB_OUTPUT
if (output) {
  appendFileSync(output, [
    `promotes_latest=${selectedTags.includes(latest)}`,
    'tags<<CONTAINER_PROMOTION_TAGS',
    ...selectedTags,
    'CONTAINER_PROMOTION_TAGS',
    ''
  ].join('\n'))
}

const skippedLatest = candidateTags.includes(latest) && !selectedTags.includes(latest)
process.stdout.write(
  skippedLatest
    ? `A higher stable version tag exists; promoting ${selectedTags.join(', ')} without moving latest.\n`
    : `Container promotion tags selected: ${selectedTags.join(', ')}.\n`
)
