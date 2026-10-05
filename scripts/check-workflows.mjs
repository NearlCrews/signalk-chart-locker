import { readdir, readFile } from 'node:fs/promises'

// Paths resolve from this file, not the working directory, so a direct run from anywhere checks
// the same tree.
const repositoryUrl = (path) => new URL(`../${path}`, import.meta.url)
const readRepositoryFile = (path) => readFile(repositoryUrl(path), 'utf8')
const workflowDirectory = '.github/workflows'
const workflowPaths = (await readdir(repositoryUrl(workflowDirectory)))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => `${workflowDirectory}/${name}`)
const failures = []

for (const path of workflowPaths) {
  const workflow = await readRepositoryFile(path)
  for (const [index, line] of workflow.split('\n').entries()) {
    const action = /\buses:\s+([^\s#]+)@([^\s#]+)/.exec(line)
    if (action !== null && !/^[0-9a-f]{40}$/.test(action[2] ?? '')) {
      failures.push(`${path}:${index + 1} must pin ${action[1]} to a full commit SHA.`)
    }
  }
  const checkoutCount = workflow.match(/uses:\s+actions\/checkout@/g)?.length ?? 0
  const disabledCredentialCount = workflow.match(/persist-credentials:\s+false/g)?.length ?? 0
  if (checkoutCount !== disabledCredentialCount) {
    failures.push(`${path} must disable persisted credentials for every checkout.`)
  }
}

const ci = await readRepositoryFile('.github/workflows/ci.yml')
for (const expected of ['node: [22, 24]', 'npm run test:browser:cross', 'npm run check:package']) {
  if (!ci.includes(expected)) failures.push(`ci.yml must retain ${expected}.`)
}

const pluginCi = await readRepositoryFile('.github/workflows/plugin-ci.yml')
if (!pluginCi.includes('SignalK/signalk-server/.github/workflows/plugin-ci.yml@')) {
  failures.push('plugin-ci.yml must retain the official Signal K reusable workflow.')
}

const publish = await readRepositoryFile('.github/workflows/publish.yml')
for (const expected of [
  'workflow_dispatch:',
  'release_tag:',
  'npm@12.1.0',
  'pack:release',
  'verify:release-tarball',
  "if: github.event_name == 'release'",
  'resolve-release:',
  'needs.resolve-release.outputs.revision',
  'RELEASE_REF_TYPE: tag',
  "needs.publish-npm.result == 'skipped'",
  'Recheck immutable release tag before publication',
  'Recheck immutable release tag before registry verification',
  'Verify npm registry contract',
  '.release-tooling/scripts/verify-npm-registry.mjs'
]) {
  if (!publish.includes(expected)) failures.push(`publish.yml must retain ${expected}.`)
}
const npmClients = new Set([...publish.matchAll(/npm install --global npm@(\S+)/g)].map((match) => match[1]))
if (npmClients.size !== 1) failures.push('publish.yml must install the same npm client in every job.')

const containerImage = await readRepositoryFile('.github/workflows/container-image.yml')
for (const [path, workflow] of [
  ['container-image.yml', containerImage],
  ['publish.yml', publish],
]) {
  const setupNodeCount = workflow.match(/uses:\s+actions\/setup-node@/g)?.length ?? 0
  const disabledCacheCount = workflow.match(/package-manager-cache:\s+false/g)?.length ?? 0
  if (setupNodeCount !== disabledCacheCount) {
    failures.push(`${path} must disable setup-node package-manager caching in every job.`)
  }
}

// The image workflow signs and attests what the publish workflow verifies, so the two must agree
// on the Cosign release and on the SPDX version that names the SBOM predicate type.
const cosignReleases = new Set(
  [containerImage, publish].flatMap((workflow) => [...workflow.matchAll(/cosign-release:\s+(\S+)/g)].map((match) => match[1]))
)
if (cosignReleases.size !== 1) failures.push('container-image.yml and publish.yml must install the same Cosign release.')
if (!containerImage.includes('spdx-json@2.3=') || !publish.includes('https://spdx.dev/Document/v2.3')) {
  failures.push('container-image.yml must emit SPDX 2.3 SBOMs and publish.yml must verify that predicate type.')
}

const dependabot = await readRepositoryFile('.github/dependabot.yml')
const ecosystemCount = dependabot.match(/package-ecosystem:/g)?.length ?? 0
const cooldownCount = dependabot.match(/default-days:\s+7/g)?.length ?? 0
if (ecosystemCount !== cooldownCount) {
  failures.push('dependabot.yml must retain a seven-day cooldown for every package ecosystem.')
}
if (
  !dependabot.includes(
    'dependency-name: "@types/node"\n        update-types:\n          - version-update:semver-major'
  )
) {
  failures.push('dependabot.yml must keep @types/node on the oldest supported Node major.')
}

const workflowSecurity = await readRepositoryFile('.github/workflows/workflow-security.yml')
for (const expected of ['actionlint@v1.7.12', 'zizmor-action@']) {
  if (!workflowSecurity.includes(expected)) failures.push(`workflow-security.yml must include ${expected}.`)
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

process.stdout.write('Workflow pins, release invariants, and security checks passed.\n')
