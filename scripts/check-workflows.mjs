import { readdir, readFile } from 'node:fs/promises'

const workflowDirectory = '.github/workflows'
const workflowPaths = (await readdir(workflowDirectory))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => `${workflowDirectory}/${name}`)
const failures = []

for (const path of workflowPaths) {
  const workflow = await readFile(path, 'utf8')
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

const ci = await readFile('.github/workflows/ci.yml', 'utf8')
for (const expected of ['node: [22, 24]', 'npm run test:browser:cross', 'npm run check:package']) {
  if (!ci.includes(expected)) failures.push(`ci.yml must retain ${expected}.`)
}

const pluginCi = await readFile('.github/workflows/plugin-ci.yml', 'utf8')
if (!pluginCi.includes('SignalK/signalk-server/.github/workflows/plugin-ci.yml@')) {
  failures.push('plugin-ci.yml must retain the official Signal K reusable workflow.')
}

const publish = await readFile('.github/workflows/publish.yml', 'utf8')
for (const expected of ['npm@12.0.2', 'pack:release', 'verify:release-tarball', 'Verify registry source commit', 'gitHead']) {
  if (!publish.includes(expected)) failures.push(`publish.yml must retain ${expected}.`)
}

const containerImage = await readFile('.github/workflows/container-image.yml', 'utf8')
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

const dependabot = await readFile('.github/dependabot.yml', 'utf8')
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

const workflowSecurity = await readFile('.github/workflows/workflow-security.yml', 'utf8')
for (const expected of ['actionlint@v1.7.12', 'zizmor-action@']) {
  if (!workflowSecurity.includes(expected)) failures.push(`workflow-security.yml must include ${expected}.`)
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

process.stdout.write('Workflow pins, release invariants, and security checks passed.\n')
