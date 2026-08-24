/**
 * Shared locked identity helper for server activation and TUI-equivalent validation.
 * Uses proper-lockfile on stateRoot, hard-link no-clobber publish, and orphan detection.
 * No raw identities are logged.
 */
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"

const LOCK_OPTS = {
  realpath: false,
  stale: 10000,
  update: 2000,
  retries: {
    retries: 5,
    factor: 1.5,
    minTimeout: 25,
    maxTimeout: 150,
    randomize: true,
  },
} as const

function randomHex32(): string {
  return crypto.randomBytes(16).toString("hex")
}

async function ensureDir(p: string, mode: number): Promise<void> {
  try {
    await fs.mkdir(p, { recursive: true })
    try {
      await fs.chmod(p, mode)
    } catch {}
  } catch {}
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, "r")
    try {
      // @ts-ignore - sync may not be available on all platforms
      if (typeof (handle as any).sync === "function") await (handle as any).sync()
      else if (typeof (handle as any).fsync === "function") await (handle as any).fsync()
    } finally {
      await handle.close()
    }
  } catch {}
}

async function tryUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p)
  } catch {}
}

async function hasProjects(stateRoot: string): Promise<boolean> {
  const dir = path.join(stateRoot, "projects")
  try {
    const entries = await fs.readdir(dir)
    return entries.length > 0
  } catch (e: any) {
    if (e?.code === "ENOENT") return false
    return true
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  try {
    const h = await fs.open(filePath, "r")
    try {
      // @ts-ignore
      if (typeof (h as any).sync === "function") await (h as any).sync()
    } finally {
      await h.close()
    }
  } catch {}
}

async function cleanupOldIdentityTemps(stateRoot: string): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(stateRoot)
  } catch {
    return
  }
  const re = /^\.identity-v1\.[1-9][0-9]*\.[0-9a-f]{32}\.tmp$/
  const now = Date.now()
  for (const name of entries) {
    if (!re.test(name)) continue
    const full = path.join(stateRoot, name)
    try {
      const st = await fs.stat(full)
      if (now - st.mtimeMs > 24 * 60 * 60 * 1000) {
        await fs.unlink(full)
      }
    } catch {}
  }
}

async function readValidIdentity(stateRoot: string): Promise<Buffer | null> {
  const p = path.join(stateRoot, "identity-v1")
  try {
    const st = await fs.stat(p)
    if (!st.isFile()) return null
    const data = await fs.readFile(p)
    if (data.length !== 32) return null
    return Buffer.from(data)
  } catch (e: any) {
    if (e?.code === "ENOENT") return null
    return null
  }
}

/**
 * Ensure identity key exists or create it under lock.
 * Returns 32-byte Buffer if available/created, null if unavailable (orphaned/invalid).
 * Caller should treat null as stats unavailable and not publish SHA256-derived buckets.
 */
export async function ensureIdentityKey(stateRoot: string): Promise<Buffer | null> {
  // Attempt to import proper-lockfile; fallback to lock-free for environments without it (tests)
  let lockfile: any = null
  try {
    const spec = "proper-lockfile"
    lockfile = await import(spec).catch(() => null)
  } catch {
    lockfile = null
  }

  if (!lockfile) {
    // Fallback without lock: still use hard-link no-clobber for correctness, but without mutual exclusion
    const existing = await readValidIdentity(stateRoot)
    if (existing) return existing
    const projectsExist = await hasProjects(stateRoot)
    if (projectsExist) return null
    // create with no-clobber link
    await ensureDir(stateRoot, 0o700)
    const key = crypto.randomBytes(32)
    const pid = process.pid
    const hex = randomHex32()
    const tmp = path.join(stateRoot, `.identity-v1.${pid}.${hex}.tmp`)
    const fin = path.join(stateRoot, "identity-v1")
    try {
      await fs.writeFile(tmp, key, { mode: 0o600 })
      await fsyncFile(tmp)
      try {
        await fs.link(tmp, fin)
        await fsyncDir(stateRoot)
        await tryUnlink(tmp)
        await fsyncDir(stateRoot)
        return Buffer.from(key)
      } catch (e: any) {
        if (e?.code === "EEXIST") {
          await tryUnlink(tmp)
          const winner = await readValidIdentity(stateRoot)
          if (winner) return winner
          return null
        }
        await tryUnlink(tmp)
        return null
      }
    } catch {
      await tryUnlink(tmp)
      return null
    }
  }

  // With lock
  await ensureDir(stateRoot, 0o700)
  let compromised = false
  const deadline = Date.now() + 500
  let release: (() => Promise<void>) | null = null
  try {
    release = await (lockfile as any).lock(stateRoot, {
      ...LOCK_OPTS,
      onCompromised: () => {
        compromised = true
      },
    })
  } catch {
    return null
  }
  if (Date.now() > deadline) {
    try {
      await release!()
    } catch {}
    return null
  }
  try {
    if (compromised) {
      // still attempt to read existing before giving up; per ADR, compromised check before publish only
    }
    const existing = await readValidIdentity(stateRoot)
    if (existing) {
      // valid existing key → use
      // opportunistically cleanup old temps before returning
      try {
        await cleanupOldIdentityTemps(stateRoot)
      } catch {}
      return existing
    }
    // No valid existing: check if there are existing projects → orphaned
    const checkState = await (async () => {
      // Need to handle invalid existing file that is not 32 bytes but exists: readValid returns null but file exists
      // In that case, per ADR malformed identity is unavailable, not orphaned check
      // We already returned null for malformed, but need to distinguish: if file exists but malformed, we should return unavailable without checking projects
      try {
        const st = await fs.stat(path.join(stateRoot, "identity-v1"))
        if (st.isFile()) {
          // file exists but not valid (we already tried read and failed) → malformed → unavailable
          try {
            const data = await fs.readFile(path.join(stateRoot, "identity-v1"))
            if (data.length !== 32) return { malformed: true } as const
          } catch {}
          // If we couldn't read, treat as malformed unavailable
          return { malformed: true } as const
        }
      } catch (e: any) {
        if (e?.code !== "ENOENT") {
          return { malformed: true } as const
        }
      }
      return { malformed: false } as const
    })()
    if (checkState.malformed) {
      try {
        await cleanupOldIdentityTemps(stateRoot)
      } catch {}
      return null
    }
    const projectsExist = await hasProjects(stateRoot)
    if (projectsExist) {
      // orphaned: absent with existing projects → unavailable
      try {
        await cleanupOldIdentityTemps(stateRoot)
      } catch {}
      return null
    }
    // absent with no projects → create
    if (compromised) {
      // do not publish if compromised before publish
      try {
        await cleanupOldIdentityTemps(stateRoot)
      } catch {}
      return null
    }
    const key = crypto.randomBytes(32)
    const pid = process.pid
    const hex = randomHex32()
    const tmp = path.join(stateRoot, `.identity-v1.${pid}.${hex}.tmp`)
    const fin = path.join(stateRoot, "identity-v1")
    try {
      await fs.writeFile(tmp, key, { mode: 0o600 })
      await fsyncFile(tmp)
      if (compromised) {
        await tryUnlink(tmp)
        try {
          await cleanupOldIdentityTemps(stateRoot)
        } catch {}
        return null
      }
      try {
        await fs.link(tmp, fin)
      } catch (e: any) {
        if (e?.code === "EEXIST") {
          await tryUnlink(tmp)
          const winner = await readValidIdentity(stateRoot)
          if (winner && winner.length === 32) {
            try {
              await cleanupOldIdentityTemps(stateRoot)
            } catch {}
            return winner
          }
          return null
        }
        const code = e?.code
        if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
          await tryUnlink(tmp)
          try {
            await cleanupOldIdentityTemps(stateRoot)
          } catch {}
          return null
        }
        await tryUnlink(tmp)
        try {
          await cleanupOldIdentityTemps(stateRoot)
        } catch {}
        return null
      }
      await fsyncDir(stateRoot)
      await tryUnlink(tmp)
      await fsyncDir(stateRoot)
      // post-publish failures (fsync, unlink) still consider key usable per ADR: once publication succeeds, use even if temp unlink fails
      try {
        await cleanupOldIdentityTemps(stateRoot)
      } catch {}
      return Buffer.from(key)
    } catch {
      await tryUnlink(tmp)
      try {
        await cleanupOldIdentityTemps(stateRoot)
      } catch {}
      return null
    }
  } finally {
    try {
      await release!()
    } catch {}
  }
}
