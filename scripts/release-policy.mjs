import assert from 'node:assert/strict'

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function validateReleaseVersion (version) {
  const match = SEMVER_PATTERN.exec(version)
  assert.ok(match, `package version is not valid SemVer: ${version}`)
  const prerelease = match[4]
  const buildMetadata = match[5]
  if (prerelease) {
    assert.ok(
      prerelease.split('.').every((identifier) => !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0')),
      `package version has a SemVer prerelease number with a leading zero: ${version}`
    )
  }
  assert.equal(buildMetadata, undefined, 'package version build metadata cannot be represented safely by an OCI tag')
  const tag = `v${version}`
  assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'package version does not form a valid OCI tag')
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    tag
  }
}

function compareCoreVersions (one, two) {
  for (const field of ['major', 'minor', 'patch']) {
    if (one[field] < two[field]) return -1
    if (one[field] > two[field]) return 1
  }
  return 0
}

function parseStableRepositoryTag (tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return undefined
  const match = SEMVER_PATTERN.exec(tag.slice(1))
  if (!match || match[4] !== undefined || match[5] !== undefined) return undefined
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3])
  }
}

export function deriveReleaseMetadata ({ packageName, version, repository, refType, releaseTag, publishLatest }) {
  assert.equal(refType, 'tag', 'release workflows must run from an existing version tag')
  assert.ok(repository, 'GITHUB_REPOSITORY is required')
  assert.ok(releaseTag, 'RELEASE_TAG or GITHUB_REF_NAME is required')
  const validatedVersion = validateReleaseVersion(version)
  assert.equal(releaseTag, validatedVersion.tag, `tag ${releaseTag} does not match package version ${version}`)

  const repositoryMatch = /^([^/]+)\/([^/]+)$/.exec(repository)
  assert.ok(repositoryMatch, `invalid GITHUB_REPOSITORY: ${repository}`)
  const [, owner, repositoryName] = repositoryMatch
  assert.equal(repositoryName, packageName, 'repository name does not match the package name')

  const image = `ghcr.io/${owner.toLowerCase()}/signalk-chart-locker-tilecache`
  const stable = validatedVersion.prerelease === undefined
  const npmTag = stable ? 'latest' : 'next'
  const tags = [`${image}:${releaseTag}`]
  if (stable && publishLatest) tags.push(`${image}:latest`)
  return { image, npmTag, releaseTag, stable, tags, version }
}

export function validateTagPromotion ({ image, tag, existingDigest, releaseDigest }) {
  assert.match(releaseDigest, /^sha256:[a-f0-9]{64}$/, 'release image digest is invalid')
  if (existingDigest) assert.match(existingDigest, /^sha256:[a-f0-9]{64}$/, 'existing image digest is invalid')
  const latestTag = `${image}:latest`
  if (tag !== latestTag && existingDigest && existingDigest !== releaseDigest) {
    throw new Error(`${tag} already points to immutable digest ${existingDigest}, not ${releaseDigest}`)
  }
  return existingDigest !== releaseDigest
}

/**
 * Drop `latest` when a higher stable version tag already exists in the repository. The image job is
 * serialized as well, so an older queued build rechecks repository tags only after a newer promotion
 * finishes and cannot move the mutable tag backward.
 */
export function selectMonotonicPromotionTags ({ candidateTags, image, repositoryTags, version }) {
  assert.ok(Array.isArray(candidateTags) && candidateTags.length > 0, 'candidateTags must not be empty')
  assert.ok(Array.isArray(repositoryTags), 'repositoryTags must be an array')
  assert.equal(new Set(candidateTags).size, candidateTags.length, 'candidateTags contains duplicates')
  assert.ok(candidateTags.every((tag) => typeof tag === 'string' && tag.startsWith(`${image}:`)), 'candidate tag is outside the expected image')

  const current = validateReleaseVersion(version)
  const versionTag = `${image}:${current.tag}`
  assert.ok(candidateTags.includes(versionTag), 'candidateTags does not contain the immutable version tag')
  const latestTag = `${image}:latest`
  if (!candidateTags.includes(latestTag)) return [...candidateTags]
  assert.equal(current.prerelease, undefined, 'a prerelease cannot promote latest')

  const newerStableExists = repositoryTags
    .map(parseStableRepositoryTag)
    .filter(Boolean)
    .some((candidate) => compareCoreVersions(candidate, current) > 0)
  return newerStableExists ? candidateTags.filter((tag) => tag !== latestTag) : [...candidateTags]
}
