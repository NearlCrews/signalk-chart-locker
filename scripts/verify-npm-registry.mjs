import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { findReleaseArtifacts } from './release-tarball-contract.mjs'
import {
  assertNpmRegistryContract,
  parseNpmViewScalar,
  tarballIntegrity
} from './npm-registry-contract.mjs'

const packageDirectory = resolve(process.env.PACKAGE_DIRECTORY ?? 'package')
const { tarball } = findReleaseArtifacts(readdirSync(packageDirectory))
const expectedIntegrity = tarballIntegrity(readFileSync(resolve(packageDirectory, tarball)))
const packageName = process.env.PACKAGE_NAME
const packageVersion = process.env.PACKAGE_VERSION
const expectedGitHead = process.env.EXPECTED_GIT_HEAD
const attempts = Number.parseInt(process.env.REGISTRY_VERIFY_ATTEMPTS ?? '12', 10)
const delayMs = Number.parseInt(process.env.REGISTRY_VERIFY_DELAY_MS ?? '5000', 10)

if (!packageName || !packageVersion || !expectedGitHead) {
  throw new Error('PACKAGE_NAME, PACKAGE_VERSION, and EXPECTED_GIT_HEAD are required')
}
if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('REGISTRY_VERIFY_ATTEMPTS must be a positive integer')
if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error('REGISTRY_VERIFY_DELAY_MS must be a nonnegative integer')

const specification = `${packageName}@${packageVersion}`
let lastError
for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    const view = (fieldName) => parseNpmViewScalar(execFileSync('npm', [
      'view',
      specification,
      fieldName,
      '--json',
      '--registry=https://registry.npmjs.org/'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), fieldName)
    assertNpmRegistryContract({
      actualGitHead: view('gitHead'),
      actualIntegrity: view('dist.integrity'),
      expectedGitHead,
      expectedIntegrity
    })
    process.stdout.write(`npm registry verified: ${specification} matches ${expectedGitHead} and the exact release tarball.\n`)
    process.exit(0)
  } catch (error) {
    lastError = error
    if (attempt < attempts) {
      process.stderr.write(`Waiting for npm registry contract (attempt ${attempt}/${attempts}): ${error.message}\n`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

throw lastError
