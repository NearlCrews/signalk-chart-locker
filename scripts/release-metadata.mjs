import { appendFileSync, readFileSync } from 'node:fs'
import { deriveReleaseMetadata } from './release-policy.mjs'
import {
  assertReleaseDocumentation,
  assertReleasePackageVersions
} from './release-docs-contract.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const repository = process.env.GITHUB_REPOSITORY
const refType = process.env.GITHUB_REF_TYPE
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
  changelog: readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  readme: readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
  securityPolicy: readFileSync(new URL('../.github/SECURITY.md', import.meta.url), 'utf8'),
  bugReportTemplate: readFileSync(new URL('../.github/ISSUE_TEMPLATE/bug_report.yml', import.meta.url), 'utf8')
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
