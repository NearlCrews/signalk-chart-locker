import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { selectOrphanedBuildVersions } from '../scripts/cleanup-container-versions.mjs'
import { buildImagetoolsPromotionArgs } from '../scripts/container-promotion-contract.mjs'
import { extractContainerManifestDigests } from '../scripts/container-manifest-contract.mjs'
import { assertPackageFiles, parsePackReport } from '../scripts/package-contract.mjs'
import {
  assertNpmRegistryContract,
  normalizeNpmViewScalar,
  parseNpmViewScalar,
  tarballIntegrity
} from '../scripts/npm-registry-contract.mjs'
import { deriveReleaseMetadata, selectMonotonicPromotionTags, validateTagPromotion } from '../scripts/release-policy.mjs'
import {
  assertReleaseDocumentation,
  assertReleasePackageVersions,
  releaseAnchor
} from '../scripts/release-docs-contract.mjs'
import { findReleaseArtifacts, packagePathFromTarEntry, parseChecksum, verifyChecksum } from '../scripts/release-tarball-contract.mjs'
import { readResponseWithLimit, writeFileAtomically } from '../scripts/rust-license-contract.mjs'

const baseRelease = {
  packageName: 'signalk-chart-locker',
  refType: 'tag',
  releaseTag: 'v1.2.3',
  repository: 'NearlCrews/signalk-chart-locker',
  version: '1.2.3'
}

test('the repository-root container context excludes everything outside the Rust build inputs', () => {
  const ignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
  assert.equal(ignore[0], '**')
  assert.deepEqual(new Set(ignore.slice(1)), new Set([
    '!container/',
    '!container/Cargo.toml',
    '!container/Cargo.lock',
    '!container/.cargo/',
    '!container/.cargo/**',
    '!container/tilecache/',
    '!container/tilecache/**',
    '!LICENSE-APACHE',
    '!THIRD_PARTY_NOTICES.md',
    '!RUST_THIRD_PARTY_LICENSES.md'
  ]))
})

test('release documentation must be finalized before a version tag can publish', () => {
  const version = '1.2.3'
  const anchor = releaseAnchor(version)
  const complete = {
    version,
    changelog: `## [Unreleased]\n\n<a id="${anchor}"></a>\n\n## [${version}] - 2026-07-16\n`,
    readme: `## What's new in ${version}\n\nSee [changes](CHANGELOG.md#${anchor}).\n`,
    securityPolicy: '| 1.2.x | Yes |',
    bugReportTemplate: 'placeholder: 1.2.x'
  }
  assert.doesNotThrow(() => assertReleaseDocumentation(complete))
  for (const field of ['changelog', 'readme', 'securityPolicy', 'bugReportTemplate']) {
    assert.throws(
      () => assertReleaseDocumentation({ ...complete, [field]: '' }),
      /must/
    )
  }
})

test('release package versions must agree in both lockfile locations', () => {
  const complete = {
    packageJson: { version: '1.2.3' },
    packageLock: { version: '1.2.3', packages: { '': { version: '1.2.3' } } }
  }
  assert.doesNotThrow(() => assertReleasePackageVersions(complete))
  assert.throws(
    () => assertReleasePackageVersions({
      ...complete,
      packageLock: { ...complete.packageLock, version: '1.2.2' }
    }),
    /must match/
  )
  assert.throws(
    () => assertReleasePackageVersions({
      ...complete,
      packageLock: { ...complete.packageLock, packages: { '': { version: '1.2.2' } } }
    }),
    /must match/
  )
})

test('container promotion applies all selected tags in one registry command', () => {
  const image = 'ghcr.io/nearlcrews/signalk-chart-locker-tilecache'
  const digest = `sha256:${'a'.repeat(64)}`
  assert.deepEqual(
    buildImagetoolsPromotionArgs({
      image,
      imageDigest: digest,
      tags: [`${image}:v1.2.3`, `${image}:latest`]
    }),
    [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      `${image}:v1.2.3`,
      '--tag',
      `${image}:latest`,
      `${image}@${digest}`
    ]
  )
})

test('stable tag pushes publish the version tag and latest', () => {
  const release = deriveReleaseMetadata({ ...baseRelease, publishLatest: true })
  assert.equal(release.npmTag, 'latest')
  assert.deepEqual(release.tags, [
    'ghcr.io/nearlcrews/signalk-chart-locker-tilecache:v1.2.3',
    'ghcr.io/nearlcrews/signalk-chart-locker-tilecache:latest'
  ])
})

test('manual stable dispatches never move latest', () => {
  const release = deriveReleaseMetadata({ ...baseRelease, publishLatest: false })
  assert.deepEqual(release.tags, [
    'ghcr.io/nearlcrews/signalk-chart-locker-tilecache:v1.2.3'
  ])
})

test('prerelease tag pushes never move latest', () => {
  const release = deriveReleaseMetadata({
    ...baseRelease,
    publishLatest: true,
    releaseTag: 'v1.2.3-beta.1',
    version: '1.2.3-beta.1'
  })
  assert.equal(release.stable, false)
  assert.equal(release.npmTag, 'next')
  assert.deepEqual(release.tags, [
    'ghcr.io/nearlcrews/signalk-chart-locker-tilecache:v1.2.3-beta.1'
  ])
})

test('release metadata rejects invalid SemVer and unsafe build metadata', () => {
  for (const version of ['1.2', '01.2.3', '1.2.3-alpha.01']) {
    assert.throws(
      () => deriveReleaseMetadata({
        ...baseRelease,
        publishLatest: true,
        releaseTag: `v${version}`,
        version
      }),
      /SemVer/
    )
  }
  assert.throws(
    () => deriveReleaseMetadata({
      ...baseRelease,
      publishLatest: true,
      releaseTag: 'v1.2.3+build.1',
      version: '1.2.3+build.1'
    }),
    /build metadata cannot be represented safely/
  )
})

test('release metadata rejects a manual branch dispatch', () => {
  assert.throws(
    () => deriveReleaseMetadata({ ...baseRelease, publishLatest: false, refType: 'branch' }),
    /existing version tag/
  )
})

test('release metadata rejects malformed repository identity', () => {
  assert.throws(
    () => deriveReleaseMetadata({ ...baseRelease, publishLatest: false, repository: 'NearlCrews/signalk-chart-locker/extra' }),
    /invalid GITHUB_REPOSITORY/
  )
})

test('version tags are immutable while latest can advance', () => {
  const image = 'ghcr.io/nearlcrews/signalk-chart-locker-tilecache'
  const previous = `sha256:${'1'.repeat(64)}`
  const release = `sha256:${'2'.repeat(64)}`
  assert.throws(
    () => validateTagPromotion({
      existingDigest: previous,
      image,
      releaseDigest: release,
      tag: `${image}:v1.2.3`
    }),
    /immutable digest/
  )
  assert.equal(validateTagPromotion({
    existingDigest: previous,
    image,
    releaseDigest: release,
    tag: `${image}:latest`
  }), true)
  assert.throws(
    () => validateTagPromotion({ image, tag: `${image}:latest`, existingDigest: 'not-a-digest', releaseDigest: release }),
    /existing image digest is invalid/
  )
})

test('latest promotion is monotonic across queued stable releases', () => {
  const image = 'ghcr.io/nearlcrews/signalk-chart-locker-tilecache'
  const candidateTags = [`${image}:v1.2.3`, `${image}:latest`]
  assert.deepEqual(selectMonotonicPromotionTags({
    candidateTags,
    image,
    repositoryTags: ['v1.2.2', 'v1.2.3', 'v1.2.4-beta.1'],
    version: '1.2.3'
  }), candidateTags, 'a prerelease does not supersede the stable latest tag')
  assert.deepEqual(selectMonotonicPromotionTags({
    candidateTags,
    image,
    repositoryTags: ['v1.2.3', 'v1.3.0'],
    version: '1.2.3'
  }), [`${image}:v1.2.3`], 'an older queued release cannot move latest backward')
  assert.deepEqual(selectMonotonicPromotionTags({
    candidateTags: [`${image}:v1.2.3`],
    image,
    repositoryTags: ['v9.0.0'],
    version: '1.2.3'
  }), [`${image}:v1.2.3`], 'manual dispatch remains version-only')
  assert.throws(() => selectMonotonicPromotionTags({
    candidateTags: ['ghcr.io/other/image:v1.2.3'],
    image,
    repositoryTags: [],
    version: '1.2.3'
  }), /outside the expected image/)
})

test('container retention deletes only old orphaned build-tag versions', () => {
  const day = 24 * 60 * 60 * 1000
  const nowMs = Date.parse('2026-07-16T12:00:00Z')
  const version = (id, ageDays, tags) => ({
    id,
    created_at: new Date(nowMs - ageDays * day).toISOString(),
    metadata: { container: { tags } }
  })
  const selected = selectOrphanedBuildVersions({
    keepNewest: 1,
    minimumAgeMs: 14 * day,
    nowMs,
    versions: [
      version(1, 30, ['build-10-1']),
      version(2, 20, ['build-11-1', 'build-11-2']),
      version(3, 2, ['build-12-1']),
      version(4, 40, []),
      version(5, 40, ['build-9-1', 'v1.2.3']),
      version(6, 40, ['latest'])
    ]
  })
  assert.deepEqual(selected.map(({ id }) => id), [2, 1])
  assert.deepEqual(selectOrphanedBuildVersions({
    keepNewest: 1,
    minimumAgeMs: 14 * day,
    nowMs,
    versions: [
      version(1, 30, ['build-10-1']),
      version(2, 20, ['build-11-1', 'build-11-2']),
      version(3, 2, ['build-12-1']),
      version(4, 40, []),
      version(5, 40, ['build-9-1', 'v1.2.3'])
    ]
  }).map(({ id }) => id), [2, 1], 'selection is deterministic and safe to retry')
  assert.throws(() => selectOrphanedBuildVersions({
    keepNewest: 0,
    minimumAgeMs: 0,
    nowMs,
    versions: [{ id: 7, created_at: 'invalid', metadata: { container: { tags: ['build-1-1'] } } }]
  }), /invalid creation time/)
  assert.throws(() => selectOrphanedBuildVersions({
    keepNewest: 0,
    minimumAgeMs: 0,
    nowMs,
    versions: [{ id: 8, created_at: new Date(nowMs).toISOString(), metadata: { container: { tags: 'build-1-1' } } }]
  }), /invalid tags/)
})

test('npm pack reports reject malformed and ambiguous JSON', () => {
  assert.throws(() => parsePackReport('not json'), /did not return a JSON report/)
  assert.throws(() => parsePackReport('[{}, {}]'), /returned 2 reports/)
  assert.throws(() => parsePackReport('{"one": {}, "two": {}}'), /returned 2 reports/)
  assert.deepEqual(parsePackReport('[{"filename":"npm-11.tgz"}]'), { filename: 'npm-11.tgz' })
  assert.deepEqual(
    parsePackReport('{"signalk-chart-locker":{"filename":"npm-12.tgz"}}'),
    { filename: 'npm-12.tgz' }
  )
})

test('package contract requires project and locked Rust license notices', () => {
  const files = [
    'dist/index.js',
    'dist/index.d.ts',
    'public/remoteEntry.js',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'LICENSE-APACHE',
    'RUST_THIRD_PARTY_LICENSES.md',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'docs/API.md',
    'docs/OPERATIONS.md'
  ]
  assert.doesNotThrow(() => assertPackageFiles(files))
  assert.throws(
    () => assertPackageFiles(files.filter((path) => path !== 'RUST_THIRD_PARTY_LICENSES.md')),
    /package is missing RUST_THIRD_PARTY_LICENSES\.md/
  )
  assert.throws(
    () => assertPackageFiles([...files, 'scripts/release-metadata.mjs']),
    /outside the publication allowlist/
  )
  assert.throws(() => assertPackageFiles([...files, 'playwright.config.ts']), /outside the publication allowlist/)
  assert.throws(() => assertPackageFiles([...files, 'README.md']), /package contains duplicate paths/)
  assert.throws(() => assertPackageFiles([...files, 'dist/../src/index.ts']), /package contains an unsafe path/)
  assert.throws(() => assertPackageFiles([...files, 'dist\\index.js']), /package contains an unsafe path/)
})

test('release artifacts require exactly one tarball and its checksum', () => {
  assert.throws(() => findReleaseArtifacts([]), /found 0/)
  assert.throws(() => findReleaseArtifacts(['one.tgz', 'two.tgz']), /found 2/)
  assert.throws(
    () => findReleaseArtifacts(['package.tgz', 'package.tgz.sha256', 'stale.tgz.sha256']),
    /must contain only/
  )
  assert.deepEqual(findReleaseArtifacts(['package.tgz', 'package.tgz.sha256']), {
    checksum: 'package.tgz.sha256',
    tarball: 'package.tgz'
  })
})

test('release tarball entries remain under the npm package root', () => {
  assert.equal(packagePathFromTarEntry('package/dist/index.js'), 'dist/index.js')
  assert.throws(() => packagePathFromTarEntry('../outside'), /outside the package root/)
  assert.throws(() => packagePathFromTarEntry('package/dist/../outside'), /unsafe path/)
  assert.throws(() => packagePathFromTarEntry('package/dist\\outside'), /unsafe path/)
})

test('release checksum verification fails closed', () => {
  const contents = Buffer.from('release artifact')
  assert.throws(() => parseChecksum('not a checksum'), /invalid format/)
  assert.throws(() => verifyChecksum(contents, '0'.repeat(64)), /does not match/)
  const expected = '133cfccb5b503cf4040c95f3dfad56d07c1574283a1e39066b594f6ee33711ba'
  assert.equal(verifyChecksum(contents, expected), expected)
})

test('npm view scalars accept npm 11 and npm 12 output without accepting ambiguity', () => {
  const commit = 'a'.repeat(40)
  assert.equal(normalizeNpmViewScalar(commit, 'gitHead'), commit)
  assert.equal(normalizeNpmViewScalar([commit], 'gitHead'), commit)
  assert.equal(parseNpmViewScalar(JSON.stringify(commit), 'gitHead'), commit)
  assert.equal(parseNpmViewScalar(JSON.stringify([commit]), 'gitHead'), commit)
  for (const value of [[], [commit, commit], '', '   ', null, 12, { value: commit }, [[commit]]]) {
    assert.throws(() => normalizeNpmViewScalar(value, 'gitHead'), /npm view gitHead/)
  }
  assert.throws(() => parseNpmViewScalar('not JSON', 'gitHead'), /valid JSON/)
})

test('npm registry contract binds the release commit and exact tarball bytes', () => {
  const contents = Buffer.from('exact release tarball')
  const integrity = tarballIntegrity(contents)
  const gitHead = 'b'.repeat(40)
  assert.equal(integrity, 'sha512-OfEghQrddmxtEksgUyBHHJasWGIrU9G+JKrNgjorJ+C7zljmftLUlb79ASCdBWWkphG5Sd86HfE8Pc/S2zJe1A==')
  assert.doesNotThrow(() => assertNpmRegistryContract({
    actualGitHead: gitHead,
    actualIntegrity: integrity,
    expectedGitHead: gitHead,
    expectedIntegrity: integrity
  }))
  assert.throws(() => assertNpmRegistryContract({
    actualGitHead: 'c'.repeat(40),
    actualIntegrity: integrity,
    expectedGitHead: gitHead,
    expectedIntegrity: integrity
  }), /gitHead/)
  assert.throws(() => assertNpmRegistryContract({
    actualGitHead: gitHead,
    actualIntegrity: tarballIntegrity(Buffer.from('different tarball')),
    expectedGitHead: gitHead,
    expectedIntegrity: integrity
  }), /dist\.integrity/)
})

test('manual publish recovery freezes the release revision and isolates publisher authority', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
  assert.match(workflow, /workflow_dispatch:\n {4}inputs:\n {6}release_tag:[\s\S]*?required: true/)
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.release_tag/)

  const resolveStart = workflow.indexOf('  resolve-release:')
  const imageStart = workflow.indexOf('  verify-image:')
  const publishStart = workflow.indexOf('  publish-npm:')
  const registryStart = workflow.indexOf('  verify-registry:')
  assert.ok(resolveStart >= 0)
  assert.ok(imageStart > resolveStart)
  assert.ok(publishStart > imageStart)
  assert.ok(registryStart > publishStart)

  const resolveJob = workflow.slice(resolveStart, imageStart)
  const downstreamJobs = workflow.slice(imageStart)
  const publishJob = workflow.slice(publishStart, registryStart)
  const registryJob = workflow.slice(registryStart)

  assert.equal(workflow.match(/ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/g)?.length, 1)
  assert.match(resolveJob, /ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/)
  assert.doesNotMatch(downstreamJobs, /ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/)
  assert.equal(downstreamJobs.match(/ref: \$\{\{ needs\.resolve-release\.outputs\.revision \}\}/g)?.length, 5)
  for (const output of ['image', 'npm_tag', 'revision', 'tag', 'version']) {
    assert.match(resolveJob, new RegExp(`^ {6}${output}:`, 'm'))
  }
  assert.match(resolveJob, /RELEASE_REF_TYPE: tag/)
  assert.match(resolveJob, /node \.release-tooling\/scripts\/release-metadata\.mjs/)
  assert.match(resolveJob, /revision=\$\(git rev-parse HEAD\)/)
  assert.match(resolveJob, /if: github\.event_name == 'release'[\s\S]*?EVENT_REVISION: \$\{\{ github\.sha \}\}[\s\S]*?git rev-parse HEAD/)

  assert.equal(workflow.match(/name: Check out release tooling/g)?.length, 2)
  assert.equal(workflow.match(/ref: \$\{\{ github\.sha \}\}/g)?.length, 2)
  assert.match(publishJob, /^ {4}if: github\.event_name == 'release'/m)
  assert.match(publishJob, /^ {4}environment: npm$/m)
  assert.match(publishJob, /^ {6}id-token: write$/m)
  assert.doesNotMatch(publishJob, /workflow_dispatch/)

  assert.match(registryJob, /\$\{\{ always\(\)/)
  assert.match(registryJob, /github\.event_name == 'release' && needs\.publish-npm\.result == 'success'/)
  assert.match(registryJob, /github\.event_name == 'workflow_dispatch' && needs\.publish-npm\.result == 'skipped'/)
  assert.match(registryJob, /^ {4}permissions:\n {6}contents: read$/m)
  assert.doesNotMatch(registryJob, /environment: npm|id-token: write|npm publish/)
  assert.match(registryJob, /\.release-tooling\/scripts\/verify-npm-registry\.mjs/)
  assert.equal(workflow.match(/git fetch --no-tags --force origin "refs\/tags\/\$\{RELEASE_TAG\}:refs\/remotes\/origin\/release-tag"/g)?.length, 2)
  assert.match(publishJob, /Recheck immutable release tag before publication/)
  assert.match(registryJob, /Recheck immutable release tag before registry verification/)
})

test('release metadata uses an explicit release ref type over the workflow branch context', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const output = execFileSync('node', ['scripts/release-metadata.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REPOSITORY: 'NearlCrews/signalk-chart-locker',
      RELEASE_CHECKOUT: root,
      RELEASE_REF_TYPE: 'tag',
      RELEASE_TAG: `v${version}`
    }
  })
  assert.match(output, new RegExp(`Release metadata verified: v${version}`))
})

test('bounded downloads reject declared and streamed overflow', async () => {
  await assert.rejects(
    readResponseWithLimit(new Response('small', { headers: { 'content-length': '100' } }), 10),
    /exceeds the 10-byte limit/
  )
  await assert.rejects(readResponseWithLimit(new Response('eleven bytes'), 10), /exceeds the 10-byte limit/)
  assert.equal((await readResponseWithLimit(new Response('small'), 10)).toString(), 'small')
})

test('atomic report writes replace the target without temporary residue', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chart-locker-atomic-write-'))
  const target = join(directory, 'report.md')
  try {
    writeFileSync(target, 'old')
    writeFileAtomically(target, 'new')
    assert.equal(readFileSync(target, 'utf8'), 'new')
    assert.deepEqual(readdirSync(directory), ['report.md'])
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('container manifest metadata requires exactly both supported architectures', () => {
  const digest = (character) => `sha256:${character.repeat(64)}`
  const manifest = {
    digest: digest('a'),
    manifests: [
      { digest: digest('b'), platform: { architecture: 'amd64', os: 'linux' } },
      { digest: digest('c'), platform: { architecture: 'arm64', os: 'linux' } }
    ]
  }
  assert.deepEqual(extractContainerManifestDigests(manifest), {
    amd64Digest: digest('b'),
    arm64Digest: digest('c'),
    indexDigest: digest('a')
  })
  assert.throws(
    () => extractContainerManifestDigests({ ...manifest, manifests: manifest.manifests.slice(0, 1) }),
    /exactly the supported Linux architectures/
  )
  assert.throws(
    () => extractContainerManifestDigests({
      ...manifest,
      manifests: [
        ...manifest.manifests,
        { digest: digest('d'), platform: { architecture: 's390x', os: 'linux' } }
      ]
    }),
    /exactly the supported Linux architectures/
  )
})

test('container smoke tests use distinct platform manifest digests', () => {
  const workflow = readFileSync(new URL('../.github/workflows/container-image.yml', import.meta.url), 'utf8')
  const manifestStep = workflow.indexOf('- name: Record the staged platform digests')
  const smokeStep = workflow.indexOf('- name: Smoke-test both staged architectures')
  const cosignStep = workflow.indexOf('- name: Install Cosign')
  assert.ok(manifestStep >= 0)
  assert.ok(smokeStep > manifestStep)
  assert.ok(cosignStep > smokeStep)

  const smokeBlock = workflow.slice(smokeStep, cosignStep)
  assert.match(smokeBlock, /AMD64_DIGEST: \$\{\{ steps\.manifests\.outputs\.amd64_digest \}\}/)
  assert.match(smokeBlock, /ARM64_DIGEST: \$\{\{ steps\.manifests\.outputs\.arm64_digest \}\}/)
  assert.match(smokeBlock, /"\$\{IMAGE\}@\$\{platform_digest\}"/)
  assert.doesNotMatch(smokeBlock, /"\$\{IMAGE\}@\$\{IMAGE_DIGEST\}"/)
})

test('container pull requests build and smoke-test the complete image', () => {
  const workflow = readFileSync(new URL('../.github/workflows/container-pr.yml', import.meta.url), 'utf8')
  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /- 'container\/\*\*'/)
  assert.match(workflow, /docker build --file container\/tilecache\/Dockerfile/)
  assert.match(workflow, /docker run --detach/)
  assert.match(workflow, /\.State\.Health/)
  for (const licenseFile of [
    'LICENSE-APACHE',
    'THIRD_PARTY_NOTICES.md',
    'RUST_THIRD_PARTY_LICENSES.md'
  ]) {
    assert.match(workflow, new RegExp(licenseFile.replace('.', '\\.')))
  }
})
