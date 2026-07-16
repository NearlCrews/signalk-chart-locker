import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackageFiles } from './package-contract.mjs'
import { findReleaseArtifacts, packagePathFromTarEntry, parseChecksum, verifyChecksum } from './release-tarball-contract.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageDirectory = resolve(root, 'package')
const artifacts = findReleaseArtifacts(readdirSync(packageDirectory))
const tarball = resolve(packageDirectory, artifacts.tarball)
const checksumFile = resolve(packageDirectory, artifacts.checksum)
const checksum = parseChecksum(readFileSync(checksumFile, 'utf8'))
assert.equal(checksum.fileName, basename(tarball), 'release checksum names a different tarball')
const digest = verifyChecksum(readFileSync(tarball), checksum.digest)

const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map(packagePathFromTarEntry)
assertPackageFiles(entries)

const packedPackage = JSON.parse(execFileSync('tar', [
  '-xOzf',
  tarball,
  'package/package.json'
], { encoding: 'utf8' }))
const sourcePackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
assert.equal(packedPackage.name, sourcePackage.name, 'release tarball package name does not match the checkout')
assert.equal(packedPackage.version, sourcePackage.version, 'release tarball version does not match the checkout')

process.stdout.write(`Release tarball verified: ${packedPackage.name}@${packedPackage.version} (sha256:${digest}).\n`)
