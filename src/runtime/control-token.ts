/** Stable authentication for the tilecache control plane. */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const TOKEN_FILE = 'tilecache-control-token'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LOCK_WAIT_MS = 10
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 2000
const MAX_TOKEN_FILE_BYTES = 128
const MAX_LEASE_FILE_BYTES = 64
const MAX_RECOVERY_OWNER_FILES = 128
const lockWait = new Int32Array(new SharedArrayBuffer(4))

interface FileIdentity {
  dev: bigint
  ino: bigint
}

function tokenPath (dataDir: string): string {
  return join(dataDir, TOKEN_FILE)
}

function validToken (value: string): boolean {
  return TOKEN_RE.test(value)
}

/** Read at most maxBytes from an already-open regular file, rejecting concurrent growth as well as
 * an initially oversized file. The extra byte closes the fstat-to-read window without allocating from
 * untrusted file size metadata. */
function readBoundedText (fd: number, maxBytes: number): string | null {
  const buffer = Buffer.alloc(maxBytes + 1)
  const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
  return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead).toString('utf8')
}

function readExistingToken (path: string): string | null {
  let fd: number | undefined
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code === 'ENOENT' || code === 'ELOOP') return null
      throw error
    }
    const info = fstatSync(fd)
    if (!info.isFile()) return null
    if (info.size > MAX_TOKEN_FILE_BYTES) return null
    const text = readBoundedText(fd, MAX_TOKEN_FILE_BYTES)
    if (text === null) return null
    const token = text.trim()
    if (!validToken(token)) return null
    // Correct overly broad permissions left by a manual copy or an older installation.
    if ((info.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
    return token
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function createToken (path: string): string {
  const token = randomBytes(32).toString('base64url')
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${token}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    // Hard-link publication is atomic and fails rather than replacing an existing winner.
    linkSync(temporary, path)
    unlinkSync(temporary)
    try {
      const directoryFd = openSync(dirname(path), 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } catch {
      // Some supported filesystems do not allow directory descriptors.
    }
    return token
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function isMissing (error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function sameIdentity (one: FileIdentity, two: FileIdentity): boolean {
  return one.dev === two.dev && one.ino === two.ino
}

/**
 * Remove a path only when it still names the file represented by the open descriptor. Recovery-owner
 * sidecars keep canonical lock publication blocked across the final identity-check-to-unlink window.
 */
function unlinkOwnedPath (path: string, identity: FileIdentity): void {
  try {
    const current = lstatSync(path, { bigint: true })
    if (sameIdentity(identity, current)) unlinkSync(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

type LeaseState =
  | { status: 'missing' }
  | { status: 'unsafe' }
  | { status: 'active', identity: FileIdentity }
  | { status: 'abandoned', identity: FileIdentity }

function ownerState (rawPid: number): 'live' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(rawPid) || rawPid <= 0) return 'unknown'
  try {
    process.kill(rawPid, 0)
    return 'live'
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    return code === 'ESRCH' ? 'dead' : code === 'EPERM' ? 'live' : 'unknown'
  }
}

function readLeasePid (fd: number, size: bigint): number {
  if (size > BigInt(MAX_LEASE_FILE_BYTES)) return Number.NaN
  const text = readBoundedText(fd, MAX_LEASE_FILE_BYTES)
  if (text === null) return Number.NaN
  const raw = text.trim()
  if (!/^[1-9]\d*$/.test(raw)) return Number.NaN
  const pid = Number(raw)
  return Number.isSafeInteger(pid) ? pid : Number.NaN
}

function inspectLease (path: string): LeaseState {
  let fd: number | undefined
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if (isMissing(error)) return { status: 'missing' }
      // A symlink, directory, or otherwise unsafe lease fails closed and is preserved for diagnosis.
      return { status: 'unsafe' }
    }
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile()) return { status: 'unsafe' }
    const identity = { dev: info.dev, ino: info.ino }
    const rawPid = readLeasePid(fd, info.size)
    const state = ownerState(rawPid)
    const stale = Date.now() - Number(info.mtimeMs) >= LOCK_STALE_MS
    return state === 'live' || (state === 'unknown' && !stale)
      ? { status: 'active', identity }
      : { status: 'abandoned', identity }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Recovery owners retain a unique sidecar hard-linked to the fixed election path. The unique pathname
 * is never reused, so reaping an abandoned sidecar cannot unlink a replacement owner. The sidecar is
 * removed last: even if cleanup of the fixed link races, a live replacement sidecar still blocks
 * canonical lock publication.
 */
function recoveryInProgress (recoveryPath: string): boolean {
  const directory = dirname(recoveryPath)
  const ownerPrefix = `${basename(recoveryPath)}.owner-`
  let entries: string[]
  try {
    entries = readdirSync(directory).filter((entry) => entry.startsWith(ownerPrefix))
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  // Bound work per pass, but still reap a batch. Returning busy when entries remain lets the outer
  // retry loop drain an abandoned-owner storm instead of making the overflow permanently unrecoverable.
  let active = entries.length > MAX_RECOVERY_OWNER_FILES
  for (const entry of entries.slice(0, MAX_RECOVERY_OWNER_FILES)) {
    const ownerPath = join(directory, entry)
    const lease = inspectLease(ownerPath)
    if (lease.status === 'active' || lease.status === 'unsafe') {
      active = true
      continue
    }
    if (lease.status !== 'abandoned') continue
    // Remove the fixed hard link first while the unique sidecar still blocks new lock publication.
    try { unlinkOwnedPath(recoveryPath, lease.identity) } catch {}
    try { unlinkOwnedPath(ownerPath, lease.identity) } catch {}
  }
  if (active) return true

  // Backward compatibility for a crashed pre-sidecar recovery lease, or an orphaned fixed link.
  const fixed = inspectLease(recoveryPath)
  if (fixed.status === 'active' || fixed.status === 'unsafe') return true
  if (fixed.status === 'abandoned') {
    try { unlinkOwnedPath(recoveryPath, fixed.identity) } catch {}
  }
  return false
}

function recoverAbandonedLock (lockPath: string, recoveryPath: string): void {
  const ownerPath = `${recoveryPath}.owner-${process.pid}-${randomBytes(12).toString('hex')}`
  let ownerFd: number | undefined
  let ownerIdentity: FileIdentity | undefined
  let elected = false
  try {
    // Publish a unique owner sidecar before entering the fixed-path election. Acquirers scan these
    // sidecars, so a live recovery continues to block canonical lock publication even if the fixed
    // hard link is concurrently cleaned up.
    ownerFd = openSync(ownerPath, 'wx', 0o600)
    writeFileSync(ownerFd, `${process.pid}\n`, 'utf8')
    fsyncSync(ownerFd)
    ownerIdentity = fstatSync(ownerFd, { bigint: true })
    try {
      linkSync(ownerPath, recoveryPath)
      elected = true
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return
      throw error
    }
    const lock = inspectLease(lockPath)
    if (lock.status === 'abandoned') unlinkOwnedPath(lockPath, lock.identity)
  } catch {
    // The owner may have completed between any two checks.
  } finally {
    if (ownerFd !== undefined) closeSync(ownerFd)
    if (ownerIdentity !== undefined && elected) {
      try { unlinkOwnedPath(recoveryPath, ownerIdentity) } catch {}
    }
    if (ownerIdentity !== undefined) {
      try { unlinkOwnedPath(ownerPath, ownerIdentity) } catch {}
    }
  }
}

interface ControlTokenDeps {
  /** Test seam for forcing a recovery owner into the check-to-open window. */
  afterCanonicalLockPublished?: (paths: { lockPath: string, recoveryPath: string }) => void
}

/** Load or atomically create the stable 32-byte control token. The token is never included in errors. */
export function getOrCreateControlToken (dataDir: string, deps: ControlTokenDeps = {}): string {
  mkdirSync(dataDir, { recursive: true })
  const path = tokenPath(dataDir)
  const existing = readExistingToken(path)
  if (existing !== null) return existing

  const lockPath = `${path}.lock`
  const recoveryPath = `${lockPath}.recovery`
  let lockFd: number | undefined
  let lockIdentity: FileIdentity | undefined
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (lockFd === undefined) {
    if (recoveryInProgress(recoveryPath)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for tilecache control-token lock recovery at ${recoveryPath}`)
      Atomics.wait(lockWait, 0, 0, LOCK_WAIT_MS)
      continue
    }
    try {
      const acquiredFd = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(acquiredFd, `${process.pid}\n`, 'utf8')
        fsyncSync(acquiredFd)
        const identity = fstatSync(acquiredFd, { bigint: true })
        deps.afterCanonicalLockPublished?.({ lockPath, recoveryPath })
        // Close the check-to-open window: a recovery owner may appear after the pre-open scan and
        // remove the prior canonical lock just before this replacement is published. Never retain a
        // canonical lock while any recovery sidecar remains active.
        if (recoveryInProgress(recoveryPath)) {
          closeSync(acquiredFd)
          try { unlinkOwnedPath(lockPath, identity) } catch {}
          if (Date.now() >= deadline) throw new Error(`timed out waiting for tilecache control-token lock recovery at ${recoveryPath}`)
          Atomics.wait(lockWait, 0, 0, LOCK_WAIT_MS)
          continue
        }
        lockFd = acquiredFd
        lockIdentity = identity
      } catch (error) {
        if (lockFd !== acquiredFd) {
          let identity: FileIdentity | undefined
          try { identity = fstatSync(acquiredFd, { bigint: true }) } catch {}
          try { closeSync(acquiredFd) } catch {}
          if (identity !== undefined) {
            try { unlinkOwnedPath(lockPath, identity) } catch {}
          }
        }
        throw error
      }
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      recoverAbandonedLock(lockPath, recoveryPath)
      if (Date.now() >= deadline) throw new Error(`timed out acquiring tilecache control-token lock at ${lockPath}`)
      Atomics.wait(lockWait, 0, 0, LOCK_WAIT_MS)
    }
  }

  try {
    // Another process may have completed creation while this caller waited for the lock.
    const winner = readExistingToken(path)
    if (winner !== null) return winner

    // An existing but invalid token is retained for diagnosis before replacement.
    try {
      // lstat observes a symlink itself, including a broken one. Following it could chmod or inspect an
      // unrelated target and then leave publication failing on the still-existing link.
      lstatSync(path)
      renameSync(path, `${path}.corrupt-${Date.now()}-${randomBytes(12).toString('hex')}`)
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
    }

    return createToken(path)
  } catch (error) {
    throw new Error(`cannot create tilecache control token at ${path}`, { cause: error })
  } finally {
    closeSync(lockFd)
    try { unlinkOwnedPath(lockPath, lockIdentity!) } catch {}
  }
}

export function controlHeaders (token: string): Record<string, string> {
  return { 'x-tilecache-token': token }
}
