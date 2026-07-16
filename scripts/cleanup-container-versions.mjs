import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const BUILD_TAG = /^build-[1-9]\d*-[1-9]\d*$/

/** Select old package versions that contain only run-scoped staging tags. Untagged platform
 * manifests and any version carrying a release tag are deliberately ineligible. */
export function selectOrphanedBuildVersions ({ keepNewest, minimumAgeMs, nowMs, versions }) {
  assert.ok(Array.isArray(versions), 'container package versions must be an array')
  assert.ok(Number.isSafeInteger(keepNewest) && keepNewest >= 0, 'keepNewest must be a non-negative integer')
  assert.ok(Number.isSafeInteger(minimumAgeMs) && minimumAgeMs >= 0, 'minimumAgeMs must be a non-negative integer')
  assert.ok(Number.isSafeInteger(nowMs) && nowMs >= 0, 'nowMs must be a non-negative integer')

  const staging = versions.flatMap((version) => {
    assert.ok(version !== null && typeof version === 'object' && !Array.isArray(version), 'container package version is malformed')
    assert.ok(Number.isSafeInteger(version.id) && version.id > 0, 'container package version id is invalid')
    const createdAt = Date.parse(version.created_at)
    assert.ok(Number.isFinite(createdAt), `container package version ${version.id} has an invalid creation time`)
    const tags = version.metadata?.container?.tags
    assert.ok(Array.isArray(tags) && tags.every((tag) => typeof tag === 'string'), `container package version ${version.id} has invalid tags`)
    if (tags.length === 0 || !tags.every((tag) => BUILD_TAG.test(tag))) return []
    return [{ createdAt, id: version.id, tags }]
  }).sort((one, two) => two.createdAt - one.createdAt || two.id - one.id)

  return staging
    .slice(keepNewest)
    .filter((version) => nowMs - version.createdAt >= minimumAgeMs)
}

async function request (url, token, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...init.headers
    },
    signal: AbortSignal.timeout(30_000)
  })
}

async function listAtEndpoint (baseUrl, token) {
  const versions = []
  for (let page = 1; page <= 100; page++) {
    const separator = baseUrl.includes('?') ? '&' : '?'
    const response = await request(`${baseUrl}${separator}per_page=100&page=${page}`, token)
    if (response.status === 404 && page === 1) return undefined
    assert.equal(response.ok, true, `GitHub package listing failed with HTTP ${response.status}`)
    const batch = await response.json()
    assert.ok(Array.isArray(batch), 'GitHub package listing did not return an array')
    versions.push(...batch)
    if (batch.length < 100) return versions
  }
  throw new Error('GitHub package listing exceeded 10,000 versions')
}

async function locatePackage (apiUrl, owner, packageName, token) {
  const encodedOwner = encodeURIComponent(owner)
  const encodedPackage = encodeURIComponent(packageName)
  for (const scope of [`users/${encodedOwner}`, `orgs/${encodedOwner}`]) {
    const baseUrl = `${apiUrl}/${scope}/packages/container/${encodedPackage}/versions`
    const versions = await listAtEndpoint(baseUrl, token)
    if (versions !== undefined) return { baseUrl, versions }
  }
  throw new Error(`container package ${owner}/${packageName} was not found for retention cleanup`)
}

async function main () {
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  const packageName = process.env.CONTAINER_PACKAGE_NAME ?? 'signalk-chart-locker-tilecache'
  const token = process.env.GITHUB_TOKEN
  const minimumAgeDays = Number(process.env.MINIMUM_AGE_DAYS ?? 14)
  const keepNewest = Number(process.env.KEEP_NEWEST_STAGING_VERSIONS ?? 3)
  assert.ok(owner, 'GITHUB_REPOSITORY_OWNER is required')
  assert.ok(token, 'GITHUB_TOKEN is required')
  assert.ok(Number.isSafeInteger(minimumAgeDays) && minimumAgeDays >= 1 && minimumAgeDays <= 3650, 'MINIMUM_AGE_DAYS is invalid')
  assert.ok(Number.isSafeInteger(keepNewest) && keepNewest >= 0 && keepNewest <= 100, 'KEEP_NEWEST_STAGING_VERSIONS is invalid')

  const located = await locatePackage(apiUrl.replace(/\/$/, ''), owner, packageName, token)
  const selected = selectOrphanedBuildVersions({
    keepNewest,
    minimumAgeMs: minimumAgeDays * 24 * 60 * 60 * 1000,
    nowMs: Date.now(),
    versions: located.versions
  })
  for (const version of selected) {
    const response = await request(`${located.baseUrl}/${version.id}`, token, { method: 'DELETE' })
    assert.equal(response.status, 204, `deleting container package version ${version.id} failed with HTTP ${response.status}`)
    process.stdout.write(`Deleted orphaned staging version ${version.id} (${version.tags.join(', ')}).\n`)
  }
  if (selected.length === 0) process.stdout.write('No orphaned container staging versions met the retention policy.\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
