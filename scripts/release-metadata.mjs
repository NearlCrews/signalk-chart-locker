import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveReleaseMetadata } from './release-policy.mjs'
import {
  assertReleaseDocumentation,
  assertReleasePackageVersions
} from './release-docs-contract.mjs'

const root = resolve(process.env.RELEASE_CHECKOUT ?? fileURLToPath(new URL('..', import.meta.url)))
const readReleaseFile = (path) => readFileSync(resolve(root, path), 'utf8')
const pkg = JSON.parse(readReleaseFile('package.json'))
const packageLock = JSON.parse(readReleaseFile('package-lock.json'))
const repository = process.env.GITHUB_REPOSITORY
const refType = process.env.RELEASE_REF_TYPE ?? process.env.GITHUB_REF_TYPE
const releaseTag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME

const { image, npmTag, stable, tags } = deriveReleaseMetadata({
  packageName: pkg.name,
  publishLatest: process.env.PUBLISH_LATEST === 'true',
  refType,
  releaseTag,
  repository,
  version: pkg.version
})
assertReleasePackageVersions({ packageJson: pkg, packageLock })
assertReleaseDocumentation({
  version: pkg.version,
  changelog: readReleaseFile('CHANGELOG.md'),
  readme: readReleaseFile('README.md'),
  securityPolicy: readReleaseFile('.github/SECURITY.md'),
  bugReportTemplate: readReleaseFile('.github/ISSUE_TEMPLATE/bug_report.yml')
})

const output = process.env.GITHUB_OUTPUT
if (output) {
  appendFileSync(output, [
    `version=${pkg.version}`,
    `tag=${releaseTag}`,
    `image=${image}`,
    `npm_tag=${npmTag}`,
    `stable=${stable}`,
    'tags<<RELEASE_TAGS',
    ...tags,
    'RELEASE_TAGS',
    ''
  ].join('\n'))
}

process.stdout.write(`Release metadata verified: ${releaseTag} -> ${tags.join(', ')}.\n`)
