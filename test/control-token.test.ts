import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { linkSync, writeFileSync } from 'node:fs'
import { chmod, link, mkdtemp, lstat, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { getOrCreateControlToken } from '../src/runtime/control-token.js'

const execFileAsync = promisify(execFile)

test('control token is stable, private, and invalid legacy content is preserved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-'))
  try {
    const first = getOrCreateControlToken(dir)
    const second = getOrCreateControlToken(dir)
    assert.equal(second, first)
    assert.match(first, /^[A-Za-z0-9_-]{43}$/)
    const path = join(dir, 'tilecache-control-token')
    // Windows reports synthesized POSIX mode bits and cannot prove the ACL through fs.stat().
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)

    await writeFile(path, 'legacy-invalid-token\n', { mode: 0o600 })
    const replacement = getOrCreateControlToken(dir)
    assert.notEqual(replacement, first)
    const files = await readdir(dir)
    assert.ok(files.some((name) => /^tilecache-control-token\.corrupt-\d+-[0-9a-f]{24}$/.test(name)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent processes publish one complete token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-race-'))
  const moduleUrl = pathToFileURL(resolve('src/runtime/control-token.ts')).href
  const script = `import { getOrCreateControlToken } from ${JSON.stringify(moduleUrl)}; process.stdout.write(getOrCreateControlToken(process.argv[1]))`
  try {
    const args = ['--import', 'tsx', '--input-type=module', '--eval', script, dir]
    const [one, two] = await Promise.all([
      execFileAsync(process.execPath, args),
      execFileAsync(process.execPath, args)
    ])
    assert.equal(one.stdout, two.stdout)
    assert.equal((await readFile(join(dir, 'tilecache-control-token'), 'utf8')).trim(), one.stdout)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('control token creation failure does not expose file contents', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-permission-'))
  const marker = 'must-not-appear-in-errors'
  try {
    await writeFile(join(dir, 'tilecache-control-token'), marker, { mode: 0o600 })
    await chmod(dir, 0o500)
    assert.throws(() => getOrCreateControlToken(dir), (error: unknown) => {
      assert.equal(String(error).includes(marker), false)
      return true
    })
  } finally {
    await chmod(dir, 0o700)
    await rm(dir, { recursive: true, force: true })
  }
})

test('oversized token and lock files are rejected without unbounded reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-bounded-read-'))
  const path = join(dir, 'tilecache-control-token')
  try {
    await writeFile(path, 'x'.repeat(1024), { mode: 0o600 })
    await writeFile(`${path}.lock`, '9'.repeat(1024), { mode: 0o600 })
    const old = new Date(Date.now() - 10_000)
    await utimes(`${path}.lock`, old, old)

    assert.match(getOrCreateControlToken(dir), /^[A-Za-z0-9_-]{43}$/)
    const files = await readdir(dir)
    assert.ok(files.some((name) => /^tilecache-control-token\.corrupt-\d+-[0-9a-f]{24}$/.test(name)))
    assert.equal(files.includes('tilecache-control-token.lock'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an abandoned control-token lock is recovered automatically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-stale-lock-'))
  try {
    await writeFile(join(dir, 'tilecache-control-token.lock'), '2147483647\n', { mode: 0o600 })
    const token = getOrCreateControlToken(dir)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await readdir(dir)).includes('tilecache-control-token.lock'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('canonical lock PID parsing rejects trailing garbage instead of borrowing a live PID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-strict-lock-pid-'))
  const lock = join(dir, 'tilecache-control-token.lock')
  try {
    await writeFile(lock, `${process.pid}garbage\n`, { mode: 0o600 })
    const old = new Date(Date.now() - 10_000)
    await utimes(lock, old, old)
    assert.match(getOrCreateControlToken(dir), /^[A-Za-z0-9_-]{43}$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent stale-lock recoverers cannot remove a replacement lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-stale-race-'))
  const moduleUrl = pathToFileURL(resolve('src/runtime/control-token.ts')).href
  const script = `import { getOrCreateControlToken } from ${JSON.stringify(moduleUrl)}; process.stdout.write(getOrCreateControlToken(process.argv[1]))`
  try {
    await writeFile(join(dir, 'tilecache-control-token.lock'), '2147483647\n', { mode: 0o600 })
    const args = ['--import', 'tsx', '--input-type=module', '--eval', script, dir]
    const results = await Promise.all(Array.from({ length: 6 }, async () => await execFileAsync(process.execPath, args)))
    assert.equal(new Set(results.map(({ stdout }) => stdout)).size, 1)
    assert.equal((await readFile(join(dir, 'tilecache-control-token'), 'utf8')).trim(), results[0]?.stdout)
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.lock') || name.includes('.recovery')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an abandoned legacy recovery lease is recovered automatically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-stale-recovery-'))
  try {
    await writeFile(join(dir, 'tilecache-control-token.lock'), '2147483647\n', { mode: 0o600 })
    await writeFile(join(dir, 'tilecache-control-token.lock.recovery'), '2147483647\n', { mode: 0o600 })
    assert.match(getOrCreateControlToken(dir), /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await readdir(dir)).some((name) => name.includes('.recovery')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an abandoned sidecar recovery lease is recovered without retaining lock artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-stale-recovery-sidecar-'))
  const lock = join(dir, 'tilecache-control-token.lock')
  const recovery = `${lock}.recovery`
  const owner = `${recovery}.owner-abandoned`
  try {
    await writeFile(lock, '2147483647\n', { mode: 0o600 })
    await writeFile(owner, `${process.pid}garbage\n`, { mode: 0o600 })
    await link(owner, recovery)
    const old = new Date(Date.now() - 10_000)
    await utimes(owner, old, old)
    assert.match(getOrCreateControlToken(dir), /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.lock') || name.includes('.recovery')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an abandoned recovery-owner storm is drained in bounded batches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-recovery-owner-storm-'))
  const lock = join(dir, 'tilecache-control-token.lock')
  const recovery = `${lock}.recovery`
  try {
    await writeFile(lock, '2147483647\n', { mode: 0o600 })
    const old = new Date(Date.now() - 10_000)
    for (let index = 0; index < 129; index++) {
      const owner = `${recovery}.owner-abandoned-${index}`
      await writeFile(owner, 'malformed\n', { mode: 0o600 })
      await utimes(owner, old, old)
    }
    assert.match(getOrCreateControlToken(dir), /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.lock') || name.includes('.recovery')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a recovery owner appearing after canonical publication forces the replacement lock to retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-post-open-recheck-'))
  const lock = join(dir, 'tilecache-control-token.lock')
  const recovery = `${lock}.recovery`
  const owner = `${recovery}.owner-injected`
  const remover = execFile(process.execPath, ['--input-type=module', '--eval', `
    const { existsSync, unlinkSync } = await import('node:fs')
    while (!existsSync(${JSON.stringify(owner)})) await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 100))
    try { unlinkSync(${JSON.stringify(recovery)}) } catch {}
    try { unlinkSync(${JSON.stringify(owner)}) } catch {}
  `])
  let injected = false
  try {
    const token = getOrCreateControlToken(dir, {
      afterCanonicalLockPublished: () => {
        if (injected) return
        injected = true
        writeFileSync(owner, `${process.pid}\n`, { mode: 0o600 })
        linkSync(owner, recovery)
      }
    })
    if (remover.exitCode === null) await new Promise<void>((resolve) => remover.once('exit', () => resolve()))
    assert.equal(injected, true)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.lock') || name.includes('.recovery')), false)
  } finally {
    if (remover.exitCode === null) remover.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('an old recovery lease owned by a live process is never reaped by age alone', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-live-recovery-'))
  const lock = join(dir, 'tilecache-control-token.lock')
  const recovery = `${lock}.recovery`
  const owner = `${recovery}.owner-live`
  try {
    await writeFile(lock, '2147483647\n', { mode: 0o600 })
    await writeFile(owner, `${process.pid}\n`, { mode: 0o600 })
    await link(owner, recovery)
    const old = new Date(Date.now() - 10_000)
    await utimes(owner, old, old)
    const remover = execFile(process.execPath, ['--input-type=module', '--eval', `
      import('node:fs').then(({ unlinkSync }) => setTimeout(() => {
        try { unlinkSync(${JSON.stringify(recovery)}) } catch {}
        try { unlinkSync(${JSON.stringify(owner)}) } catch {}
      }, 250))
    `])
    const started = Date.now()
    const token = getOrCreateControlToken(dir)
    const elapsed = Date.now() - started
    await new Promise<void>((resolve) => remover.once('exit', () => resolve()))
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.ok(elapsed >= 150, `live owner recovery lease was reaped after only ${elapsed} ms`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a planted token symlink is preserved without chmodding its target', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-symlink-'))
  const target = join(dir, 'unrelated')
  const tokenPath = join(dir, 'tilecache-control-token')
  try {
    await writeFile(target, `${'a'.repeat(43)}\n`, { mode: 0o644 })
    const modeBefore = (await stat(target)).mode & 0o777
    await symlink(target, tokenPath)
    const token = getOrCreateControlToken(dir)
    assert.notEqual(token, 'a'.repeat(43))
    assert.equal((await stat(target)).mode & 0o777, modeBefore)
    assert.equal((await readFile(target, 'utf8')).trim(), 'a'.repeat(43))
    const backup = (await readdir(dir)).find((name) => name.startsWith('tilecache-control-token.corrupt-'))
    assert.ok(backup)
    assert.equal((await lstat(join(dir, backup))).isSymbolicLink(), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a broken token symlink is preserved before token publication', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-broken-symlink-'))
  const tokenPath = join(dir, 'tilecache-control-token')
  try {
    await symlink(join(dir, 'missing-target'), tokenPath)
    assert.match(getOrCreateControlToken(dir), /^[A-Za-z0-9_-]{43}$/)
    const backup = (await readdir(dir)).find((name) => name.startsWith('tilecache-control-token.corrupt-'))
    assert.ok(backup)
    assert.equal((await lstat(join(dir, backup))).isSymbolicLink(), true)
    assert.equal((await lstat(tokenPath)).isFile(), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an old lock owned by a live process is never reaped by age alone', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-token-live-lock-'))
  const lock = join(dir, 'tilecache-control-token.lock')
  try {
    await writeFile(lock, `${process.pid}\n`, { mode: 0o600 })
    const old = new Date(Date.now() - 10_000)
    await utimes(lock, old, old)
    const remover = execFile(process.execPath, ['--input-type=module', '--eval', `setTimeout(() => import('node:fs').then(({ unlinkSync }) => { try { unlinkSync(${JSON.stringify(lock)}) } catch {} }), 250)`])
    const started = Date.now()
    const token = getOrCreateControlToken(dir)
    const elapsed = Date.now() - started
    await new Promise<void>((resolve) => remover.once('exit', () => resolve()))
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.ok(elapsed >= 150, `live owner lock was reaped after only ${elapsed} ms`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
