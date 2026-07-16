import assert from 'node:assert/strict'

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function releaseAnchor (version) {
  return `v${version.replace(/[^A-Za-z0-9]+/g, '')}`
}

export function assertReleasePackageVersions ({ packageJson, packageLock }) {
  assert.equal(
    packageLock.version,
    packageJson.version,
    'package-lock.json version must match package.json'
  )
  assert.equal(
    packageLock.packages?.['']?.version,
    packageJson.version,
    "package-lock.json packages[''].version must match package.json"
  )
}

export function assertReleaseDocumentation ({
  version,
  changelog,
  readme,
  securityPolicy,
  bugReportTemplate
}) {
  const anchor = releaseAnchor(version)
  const escapedVersion = escapeRegExp(version)
  assert.match(
    changelog,
    new RegExp(`<a id="${anchor}"></a>\\s+## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}`),
    `CHANGELOG.md must contain a dated ${version} section with anchor ${anchor}`
  )
  assert.ok(
    readme.includes(`## What's new in ${version}`),
    `README.md must present ${version} as released`
  )
  assert.ok(
    readme.includes(`CHANGELOG.md#${anchor}`),
    `README.md must link to the ${version} changelog anchor`
  )
  assert.ok(
    !readme.includes(`## What's coming in ${version}`) && !readme.includes('CHANGELOG.md#unreleased'),
    `README.md must not retain unreleased ${version} copy`
  )
  const [major, minor] = version.split('.')
  const releaseLine = `${major}.${minor}.x`
  assert.match(
    securityPolicy,
    new RegExp(`^\\|\\s*${escapeRegExp(releaseLine)}\\s*\\|\\s*Yes\\s*\\|`, 'm'),
    `.github/SECURITY.md must identify ${releaseLine} as supported`
  )
  assert.ok(
    bugReportTemplate.includes(`placeholder: ${releaseLine}`),
    `.github/ISSUE_TEMPLATE/bug_report.yml must request ${releaseLine}`
  )
}
