import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readResponseWithLimit, writeFileAtomically } from './rust-license-contract.mjs'

const VERSION = '0.9.1'
const MAXIMUM_ARCHIVE_BYTES = 32 * 1024 * 1024
const RELEASE = `https://github.com/EmbarkStudios/cargo-about/releases/download/${VERSION}`
const RELEASES = {
  'linux-arm64': {
    archive: `cargo-about-${VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    digest: 'd13ff19fedb566f859831c0b71c22120e7c598c7753d5f1018dd7353c6ced02a'
  },
  'linux-x64': {
    archive: `cargo-about-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    digest: 'c0e7dc6f5d74b0beec5c0053d39ab24514c717d19acd91886907a22457ea9e98'
  }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const container = resolve(root, 'container')
const report = resolve(root, 'RUST_THIRD_PARTY_LICENSES.md')
const write = process.argv.includes('--write')
const temporaryTools = mkdtempSync(join(tmpdir(), 'chart-locker-tools-'))
const generated = join(temporaryTools, 'RUST_THIRD_PARTY_LICENSES.md')

function validateCargoAbout (binary) {
  assert.equal(
    execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    `cargo-about ${VERSION}`,
    `cargo-about must be version ${VERSION}`
  )
  return binary
}

async function cargoAboutPath () {
  if (process.env.CARGO_ABOUT) return validateCargoAbout(resolve(process.env.CARGO_ABOUT))
  const release = RELEASES[`${process.platform}-${process.arch}`]
  assert.ok(release, 'set CARGO_ABOUT to a cargo-about 0.9.1 binary on this platform')
  const tools = temporaryTools
  const archive = join(tools, release.archive)
  const extracted = join(tools, release.archive.replace(/\.tar\.gz$/, ''))
  const binary = join(extracted, 'cargo-about')
  const response = await fetch(`${RELEASE}/${release.archive}`, { signal: AbortSignal.timeout(30_000) })
  assert.equal(response.ok, true, `cargo-about download returned HTTP ${response.status}`)
  const archiveContents = await readResponseWithLimit(response, MAXIMUM_ARCHIVE_BYTES)
  writeFileSync(archive, archiveContents)
  const digest = createHash('sha256').update(archiveContents).digest('hex')
  assert.equal(digest, release.digest, 'cargo-about archive checksum does not match the pinned release')

  rmSync(extracted, { force: true, recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', tools])
  return validateCargoAbout(binary)
}

try {
  const binary = await cargoAboutPath()
  execFileSync('cargo', ['fetch', '--locked', '--manifest-path', join(container, 'Cargo.toml')], { stdio: 'inherit' })
  execFileSync(binary, [
    'generate',
    '--config', join(container, 'about.toml'),
    '--fail',
    '--frozen',
    '--manifest-path', join(container, 'Cargo.toml'),
    '--output-file', generated,
    '--workspace',
    join(container, 'about.hbs')
  ], { cwd: container, stdio: 'inherit' })
  const contents = readFileSync(generated, 'utf8')
    .replaceAll('\u2014', '&mdash;')
    .replace(/[ \t]+$/gm, '')
  if (write) {
    writeFileAtomically(report, contents)
    process.stdout.write(`Updated ${report}.\n`)
  } else {
    assert.ok(existsSync(report), 'Rust license report is missing; run npm run licenses:rust:update')
    assert.equal(readFileSync(report, 'utf8'), contents, 'Rust license report is stale; run npm run licenses:rust:update')
    process.stdout.write('Rust third-party license report matches the locked runtime dependency graph.\n')
  }
} finally {
  rmSync(temporaryTools, { force: true, recursive: true })
}
