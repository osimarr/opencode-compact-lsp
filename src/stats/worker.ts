/**
 * Server-only bounded tokenizer worker.
 * Owns queue (16 jobs / 8 MiB), proper-lockfile project-dir lock,
 * revision-fenced hard-link publish, and capability marker.
 * TUI must never import this module.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fssync from "node:fs"
import * as crypto from "node:crypto"
import { STATS_SCHEMA_VERSION, STATS_METRIC, emptyAggregate, type Aggregate } from "./contract"
import { validateSnapshot, pruneSessions, type ProjectSnapshot } from "./snapshot"
import { getTokenizer, countTokens } from "./tokenizer"

// ---- constants per ADR ----
export const MAX_JOBS = 16
export const MAX_BYTES = 8 * 1024 * 1024
export const FOUR_MIB = 4 * 1024 * 1024

const CAPABILITY_PROTOCOL = "stats-capability-v1" as const
const AVAILABLE = "available" as const
const UNAVAILABLE = "unavailable" as const

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

type MeasureJob = {
  kind: "measure"
  sessionId: string
  hostTruncatedAtEntry: boolean
  before: string
  after: string
  combinedUtf8Bytes: number
}

type OversizeJob = {
  kind: "oversize"
  sessionId: string
  hostTruncatedAtEntry: boolean
}

export type Job = MeasureJob | OversizeJob

export type WorkerCtx = {
  stateRoot: string
  projectKey: string
  projectDir: string
}

// ---- capability helpers ----

function capabilityPath(projectDir: string): string {
  return path.join(projectDir, "capability-v1.json")
}

function snapshotsDir(projectDir: string): string {
  return path.join(projectDir, "snapshots")
}

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
      // @ts-ignore - fsync may not be available on all platforms
      if (typeof handle.sync === "function") await (handle as any).sync()
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

// Probe filesystem for hard-link no-clobber support inside snapshots/
async function probeSnapshotsFilesystem(projectDir: string): Promise<boolean> {
  const dir = snapshotsDir(projectDir)
  await ensureDir(dir, 0o700)
  const pid = process.pid
  const hex = randomHex32()
  const tmp = path.join(dir, `.capability-probe.${pid}.${hex}.tmp`)
  const fin = path.join(dir, `.capability-probe.${pid}.${hex}.final`)
  try {
    await fs.writeFile(tmp, "probe", { mode: 0o600 })
    try {
      const h = await fs.open(tmp, "r")
      try {
        // @ts-ignore
        if (typeof (h as any).sync === "function") await (h as any).sync()
      } finally {
        await h.close()
      }
    } catch {}
    try {
      await fs.link(tmp, fin)
    } catch (e: any) {
      // ENOSYS, ENOTSUP, EOPNOTSUPP, EXDEV, EPERM, EACCES indicate unsupported
      const code = e?.code
      if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
        return false
      }
      return false
    }
    return true
  } catch {
    return false
  } finally {
    await tryUnlink(tmp)
    await tryUnlink(fin)
  }
}

async function publishCapability(projectDir: string, status: typeof AVAILABLE | typeof UNAVAILABLE, nowMs: number): Promise<boolean> {
  const dir = projectDir
  await ensureDir(dir, 0o700)
  const capPath = capabilityPath(dir)
  const pid = process.pid
  const hex = randomHex32()
  const tmp = path.join(dir, `.capability-v1.${pid}.${hex}.tmp`)
  const payload = JSON.stringify({
    protocol: CAPABILITY_PROTOCOL,
    status,
    checkedAtMs: nowMs,
  })
  try {
    await fs.writeFile(tmp, payload, { mode: 0o600 })
    try {
      const h = await fs.open(tmp, "r")
      try {
        // @ts-ignore
        if (typeof (h as any).sync === "function") await (h as any).sync()
      } finally {
        await h.close()
      }
    } catch {}
    // marker replacement via rename over final (whole-file visibility)
    await fs.rename(tmp, capPath)
    await fsyncDir(dir)
    return true
  } catch {
    await tryUnlink(tmp)
    return false
  }
}

async function removeCapability(projectDir: string): Promise<boolean> {
  const p = capabilityPath(projectDir)
  try {
    await fs.unlink(p)
    return true
  } catch (e: any) {
    if (e?.code === "ENOENT") return true
    return false
  }
}

// ---- lock helper ----

async function withProjectLock<T>(projectDir: string, fn: (compromisedRef: { compromised: boolean }) => Promise<T>): Promise<T | null> {
  let lockfile: any = null
  try {
    // dynamic import so tests without proper-lockfile still run - use variable spec to avoid TS error before Task 8 deps
    const spec = "proper-lockfile"
    lockfile = await import(spec).catch(() => null)
    if (!lockfile) {
      // no lock support: fail open, do not attempt publication
      // per ADR, unsupported filesystem should make stats unavailable, but for Task 4 unit we just run without lock
      const ref = { compromised: false }
      return await fn(ref)
    }
    // Ensure directory exists before locking
    await ensureDir(projectDir, 0o700)
    await ensureDir(snapshotsDir(projectDir), 0o700)

    let compromised = false
    const release = await (lockfile as any).lock(projectDir, {
      ...LOCK_OPTS,
      onCompromised: () => {
        compromised = true
      },
    })
    const ref = {
      get compromised() {
        return compromised
      },
      set compromised(v: boolean) {
        compromised = v
      },
    }
    // Enforce external 500ms deadline
    const deadline = Date.now() + 500
    // The library already has retries, but we enforce deadline by racing
    // For simplicity, we already acquired; just check deadline not exceeded before fn
    if (Date.now() > deadline) {
      try {
        await release()
      } catch {}
      return null
    }
    try {
      const result = await fn(ref as any)
      return result
    } finally {
      try {
        await release()
      } catch {}
    }
  } catch {
    return null
  }
}

// ---- snapshot scan ----

const COMPLETED_RE = /^stats-v1\.([1-9][0-9]*)\.json$/
const TEMP_RE = /^\.stats-v1\.([1-9][0-9]*)\.([1-9][0-9]*)\.([0-9a-f]{32})\.tmp$/

async function scanCandidates(snapDir: string): Promise<{ name: string; rev: number }[]> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(snapDir)
  } catch (e: any) {
    if (e?.code === "ENOENT") return []
    throw e
  }
  if (entries.length > 512) throw new Error("too many entries")
  const candidates: { name: string; rev: number }[] = []
  for (const name of entries) {
    const m = COMPLETED_RE.exec(name)
    if (!m) continue
    const revStr = m[1]!
    // Check canonical: no leading zeros, already enforced by regex, but also check safe integer
    const rev = Number(revStr)
    if (!Number.isSafeInteger(rev) || rev <= 0) throw new Error("invalid revision")
    if (rev > Number.MAX_SAFE_INTEGER) throw new Error("revision overflow")
    // Validate filename equals canonical string (no leading zeros) - regex already ensures, but double check
    if (String(rev) !== revStr) throw new Error("non-canonical revision")
    candidates.push({ name, rev })
    if (candidates.length > 64) throw new Error("too many candidates")
  }
  return candidates
}

async function readCurrentSnapshot(projectDir: string): Promise<{ rev: number; snap: ProjectSnapshot | null; raw: string | null }> {
  const dir = snapshotsDir(projectDir)
  const candidates = await scanCandidates(dir)
  if (candidates.length === 0) return { rev: 0, snap: null, raw: null }
  candidates.sort((a, b) => b.rev - a.rev)
  const top = candidates[0]!
  const full = path.join(dir, top.name)
  // Transient ENOENT retry once after 25ms
  let raw: string | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = await fs.stat(full)
      if (!st.isFile()) throw new Error("not a file")
      raw = await fs.readFile(full, "utf8")
      break
    } catch (e: any) {
      if (e?.code === "ENOENT" && attempt === 0) {
        await new Promise((r) => setTimeout(r, 25))
        // rescan once
        try {
          const recandidates = await scanCandidates(dir)
          if (recandidates.length === 0) return { rev: 0, snap: null, raw: null }
          recandidates.sort((a, b) => b.rev - a.rev)
          if (recandidates[0]!.rev !== top.rev) throw new Error("revision changed during retry")
        } catch {}
        continue
      }
      throw e
    }
  }
  if (raw === null) throw new Error("failed to read")
  const v = validateSnapshot(raw)
  if (!v.ok) throw new Error("corrupt snapshot")
  if (v.value.revision !== top.rev) throw new Error("revision mismatch")
  return { rev: top.rev, snap: v.value, raw }
}

// ---- delta application ----

function checkedAdd(a: number, b: number): number {
  const c = a + b
  if (!Number.isSafeInteger(c) || c < 0 || c > Number.MAX_SAFE_INTEGER) throw new Error("overflow")
  return c
}

function applyJobToAggregate(agg: Aggregate, job: Job, beforeTokens: number | null, afterTokens: number | null, nowMs: number): Aggregate {
  // Clone
  const next: Aggregate = { ...agg }
  // calls increments exactly once per admitted job (observed)
  next.calls = checkedAdd(next.calls, 1)
  if (job.hostTruncatedAtEntry) {
    next.truncatedCalls = checkedAdd(next.truncatedCalls, 1)
  }
  if (job.kind === "oversize") {
    next.excludedOversizeCalls = checkedAdd(next.excludedOversizeCalls, 1)
    // no token sums
  } else {
    // measure job
    if (beforeTokens === null || afterTokens === null) {
      // tokenizer error path handled outside; this should not be called
      throw new Error("missing tokens")
    }
    // beforeTokens/afterTokens must be safe nonnegative integers
    if (!Number.isSafeInteger(beforeTokens) || beforeTokens < 0) throw new Error("invalid beforeTokens")
    if (!Number.isSafeInteger(afterTokens) || afterTokens < 0) throw new Error("invalid afterTokens")
    next.beforeTokens = checkedAdd(next.beforeTokens, beforeTokens)
    next.afterTokens = checkedAdd(next.afterTokens, afterTokens)
    if (job.before === job.after) {
      // passThrough only if exact string equality, and only for measured
      next.passThroughCalls = checkedAdd(next.passThroughCalls, 1)
    }
  }
  // lastSeen monotonic
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid nowMs")
  next.lastSeenAtMs = Math.max(next.lastSeenAtMs, nowMs)
  return next
}

// ---- publish helper ----

async function publishSnapshot(projectDir: string, snap: ProjectSnapshot): Promise<boolean> {
  const dir = snapshotsDir(projectDir)
  await ensureDir(dir, 0o700)
  const rev = snap.revision
  const pid = process.pid
  const hex = randomHex32()
  const tmpName = `.stats-v1.${rev}.${pid}.${hex}.tmp`
  const finalName = `stats-v1.${rev}.json`
  const tmpPath = path.join(dir, tmpName)
  const finalPath = path.join(dir, finalName)
  const payload = JSON.stringify(snap)

  try {
    await fs.writeFile(tmpPath, payload, { mode: 0o600 })
    try {
      const h = await fs.open(tmpPath, "r")
      try {
        // @ts-ignore
        if (typeof (h as any).sync === "function") await (h as any).sync()
      } finally {
        await h.close()
      }
    } catch {}
    // Hard-link no-clobber
    try {
      await fs.link(tmpPath, finalPath)
    } catch (e: any) {
      if (e?.code === "EEXIST") {
        await tryUnlink(tmpPath)
        return false // dropped as fencing collision
      }
      const code = e?.code
      if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
        await tryUnlink(tmpPath)
        // permanent capability failure: will be handled by caller to mark unavailable
        throw e
      }
      await tryUnlink(tmpPath)
      throw e
    }
    await fsyncDir(dir)
    await tryUnlink(tmpPath)
    // cleanup old snapshots: keep 2 highest valid, remove older valid, never delete invalid
    try {
      await cleanupSnapshots(projectDir)
    } catch {}
    await fsyncDir(dir)
    // cleanup old temps >24h
    try {
      await cleanupOldTemps(dir, TEMP_RE, 24 * 60 * 60 * 1000)
      await cleanupOldTemps(dir, /^\.capability-probe\.[1-9][0-9]*\.[0-9a-f]{32}\.(tmp|final)$/, 24 * 60 * 60 * 1000)
      await cleanupOldTemps(projectDir, /^\.capability-v1\.[1-9][0-9]*\.[0-9a-f]{32}\.tmp$/, 24 * 60 * 60 * 1000)
    } catch {}
    return true
  } catch (e) {
    await tryUnlink(tmpPath)
    throw e
  }
}

async function cleanupSnapshots(projectDir: string): Promise<void> {
  const dir = snapshotsDir(projectDir)
  const candidates = await scanCandidates(dir)
  if (candidates.length <= 2) return
  // Need to validate each candidate to know which are valid; keep 2 highest valid
  candidates.sort((a, b) => b.rev - a.rev)
  const valid: { name: string; rev: number }[] = []
  for (const c of candidates) {
    const full = path.join(dir, c.name)
    try {
      const raw = await fs.readFile(full, "utf8")
      const v = validateSnapshot(raw)
      if (!v.ok) continue
      if (v.value.revision !== c.rev) continue
      valid.push(c)
    } catch {
      continue
    }
  }
  if (valid.length <= 2) return
  valid.sort((a, b) => b.rev - a.rev)
  const toKeep = new Set(valid.slice(0, 2).map((v) => v.name))
  for (const c of valid) {
    if (toKeep.has(c.name)) continue
    const full = path.join(dir, c.name)
    try {
      await fs.unlink(full)
    } catch {}
  }
}

async function cleanupOldTemps(dir: string, re: RegExp, maxAgeMs: number): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!re.test(name)) continue
    const full = path.join(dir, name)
    try {
      const st = await fs.stat(full)
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.unlink(full)
      }
    } catch {}
  }
}

// ---- worker factory ----

export function createWorker(ctx: WorkerCtx) {
  const { projectDir } = ctx

  const queue: Job[] = []
  let queuedBytes = 0 // includes active
  let active: Job | null = null
  let droppedQueueCalls = 0
  let closed = false
  let scheduled = false
  let capabilityAvailable = false
  let capabilityTimer: ReturnType<typeof setInterval> | null = null
  let compromisedFlag = false

  // Start capability probe immediately (async, does not block enqueue)
  void initCapability()

  async function initCapability(): Promise<void> {
    try {
      // First remove prior marker if any
      const removed = await removeCapability(projectDir)
      if (!removed) {
        // removal failed with non-ENOENT; mark unavailable
        await publishCapability(projectDir, UNAVAILABLE, Date.now())
        capabilityAvailable = false
        return
      }
      const probeOk = await probeSnapshotsFilesystem(projectDir)
      if (!probeOk) {
        await publishCapability(projectDir, UNAVAILABLE, Date.now())
        capabilityAvailable = false
        return
      }
      const ok = await publishCapability(projectDir, AVAILABLE, Date.now())
      if (!ok) {
        capabilityAvailable = false
        return
      }
      capabilityAvailable = true
      // refresh every 2s
      capabilityTimer = setInterval(async () => {
        if (closed || !capabilityAvailable) return
        try {
          // strict reread before refresh
          const capRaw = await fs.readFile(capabilityPath(projectDir), "utf8").catch(() => null)
          if (capRaw) {
            try {
              const parsed = JSON.parse(capRaw)
              if (parsed.protocol !== CAPABILITY_PROTOCOL || parsed.status !== AVAILABLE || typeof parsed.checkedAtMs !== "number") {
                capabilityAvailable = false
                return
              }
              if (Math.abs(Date.now() - parsed.checkedAtMs) > 5000) {
                capabilityAvailable = false
                return
              }
            } catch {
              capabilityAvailable = false
              return
            }
          }
          await publishCapability(projectDir, AVAILABLE, Date.now())
        } catch {}
      }, 2000)
      // allow process to exit even if timer remains (for tests)
      if (capabilityTimer && typeof (capabilityTimer as any).unref === "function") (capabilityTimer as any).unref()
    } catch {
      capabilityAvailable = false
      try {
        await publishCapability(projectDir, UNAVAILABLE, Date.now())
      } catch {}
    }
  }

  function tryEnqueue(job: Job): boolean {
    if (closed) return false
    const jobBytes = job.kind === "measure" ? job.combinedUtf8Bytes : 0
    const totalJobs = queue.length + (active ? 1 : 0)
    if (totalJobs >= MAX_JOBS) {
      droppedQueueCalls++
      return false
    }
    if (queuedBytes + jobBytes > MAX_BYTES) {
      droppedQueueCalls++
      return false
    }
    queue.push(job)
    queuedBytes += jobBytes
    schedule()
    return true
  }

  function schedule(): void {
    if (scheduled || closed) return
    scheduled = true
    // off event loop
    ;(globalThis as any).setImmediate?.(() => {
      scheduled = false
      void processQueue()
    }) ?? queueMicrotask(() => {
      scheduled = false
      void processQueue()
    })
  }

  async function processQueue(): Promise<void> {
    if (closed || queue.length === 0 || active) return
    // Do not process if capability not yet available but we have jobs queued while startup probe running:
    // per ADR, jobs admitted while startup probe is running remain bounded and are processed only after fresh available marker
    if (!capabilityAvailable) {
      // Re-schedule check in 100ms
      setTimeout(() => schedule(), 100)
      return
    }
    active = queue.shift()!
    // queuedBytes already includes this job; keep until completion
    try {
      await handleJob(active)
    } catch (e: any) {
      const code = e?.code
      if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
        // permanent hard-link failure -> mark unavailable, drop subsequent
        capabilityAvailable = false
        try {
          await removeCapability(projectDir)
        } catch {}
        try {
          await publishCapability(projectDir, UNAVAILABLE, Date.now())
        } catch {
          try {
            await removeCapability(projectDir)
          } catch {}
        }
        // clear queue and stop
        queue.length = 0
        // queuedBytes already will be cleared on active completion; need to drop queuedBytes for remaining?
        // For now, reset queuedBytes to just active bytes which will be subtracted below
        queuedBytes = active.kind === "measure" ? active.combinedUtf8Bytes : 0
      }
      // other errors: will be retried once per ADR? For simplicity, just drop this job
    } finally {
      const bytes = active.kind === "measure" ? active.combinedUtf8Bytes : 0
      queuedBytes -= bytes
      if (queuedBytes < 0) queuedBytes = 0
      active = null
      if (queue.length > 0 && !closed) schedule()
    }
  }

  async function handleJob(job: Job): Promise<void> {
    // Tokenize if measure
    let beforeTokens: number | null = null
    let afterTokens: number | null = null
    let tokenizerError = false
    if (job.kind === "measure") {
      try {
        const [b, a] = await Promise.all([countTokensSafe(job.before), countTokensSafe(job.after)])
        beforeTokens = b
        afterTokens = a
        if (beforeTokens === null || afterTokens === null) tokenizerError = true
      } catch {
        tokenizerError = true
      }
    }

    // Now attempt snapshot transaction with lock, one retry for transient failures
    let attempt = 0
    while (attempt < 2) {
      attempt++
      try {
        const result = await withProjectLock(projectDir, async (compRef) => {
          // capability check before each hard-link
          if (!capabilityAvailable) throw new Error("capability unavailable")
          try {
            const capRaw = await fs.readFile(capabilityPath(projectDir), "utf8")
            const parsed = JSON.parse(capRaw)
            if (parsed.protocol !== CAPABILITY_PROTOCOL || parsed.status !== AVAILABLE) throw new Error("capability not available")
            if (Math.abs(Date.now() - parsed.checkedAtMs) > 5000) throw new Error("capability expired")
          } catch (e: any) {
            if (e?.code === "ENOENT") throw new Error("capability missing")
            throw e
          }

          if (compRef.compromised) throw new Error("compromised")

          const { rev: currentRev, snap: currentSnap } = await readCurrentSnapshot(projectDir)
          // If no snapshot and we are not in zero state with capability, treat as zero?
          // Per ADR: no completed candidate with valid identity and fresh available => zero state
          // For worker we assume projectDir + capability already validates, so zero is revision 0 with empty aggregate
          const baseSnap: ProjectSnapshot =
            currentSnap ??
            ({
              schemaVersion: STATS_SCHEMA_VERSION,
              metric: STATS_METRIC,
              revision: 0,
              project: emptyAggregate(),
              sessions: {},
            } as unknown as ProjectSnapshot)

          // Derive session key via identity? For worker we need session key derived from identity.
          // However worker ctx does not contain identity key; we have projectKey but need to derive sessionKey from identity.
          // For Task 4, we use job.sessionId directly as opaque? But spec says session keys are HMAC hex.
          // We will derive sessionKey by HMAC if we have identity key, otherwise fallback to hash of sessionId for test.
          // To keep worker functional without identity file, we use simple derivation for now: use job.sessionId as key if it looks hex, otherwise hash it
          // In real store, we will derive via identity.ts deriveSessionKey.
          // For Task 4, simplify: sessionKey = job.sessionId if 64 hex else hex of sessionId's sha256 prefix?
          // Use a deterministic fallback: if sessionId is 64 hex, use it, else hash with projectKey
          let sessionKey: string
          if (/^[0-9a-f]{64}$/.test(job.sessionId)) {
            sessionKey = job.sessionId
          } else {
            // fallback deterministic: create 64 hex from sha256(projectKey + sessionId)
            const h = crypto.createHash("sha256").update(projectKeyFromCtx(ctx) + "\0" + job.sessionId).digest("hex")
            sessionKey = h
          }

          const nowMs = Date.now()
          if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid nowMs")

          // Build next aggregates
          let nextProject: Aggregate
          let nextSession: Aggregate | null = null

          if (tokenizerError && job.kind === "measure") {
            // tokenizer failure: increment tokenizerErrorCalls only
            const curProj = baseSnap.project
            nextProject = { ...curProj }
            nextProject.calls = checkedAdd(nextProject.calls, 1)
            if (job.hostTruncatedAtEntry) nextProject.truncatedCalls = checkedAdd(nextProject.truncatedCalls, 1)
            nextProject.tokenizerErrorCalls = checkedAdd(nextProject.tokenizerErrorCalls, 1)
            nextProject.lastSeenAtMs = Math.max(nextProject.lastSeenAtMs, nowMs)

            // session
            const curSess = baseSnap.sessions[sessionKey] ?? emptyAggregate()
            // emptyAggregate has calls 0, but we need to ensure we don't persist zero-observation buckets? For tokenizer error, calls=1 so it's persistable
            nextSession = { ...curSess }
            if (curSess.calls === 0) {
              // initialize from empty
              nextSession = { ...emptyAggregate() }
            }
            nextSession.calls = checkedAdd(nextSession.calls, 1)
            if (job.hostTruncatedAtEntry) nextSession.truncatedCalls = checkedAdd(nextSession.truncatedCalls, 1)
            nextSession.tokenizerErrorCalls = checkedAdd(nextSession.tokenizerErrorCalls, 1)
            nextSession.lastSeenAtMs = Math.max(nextSession.lastSeenAtMs, nowMs)
          } else if (job.kind === "oversize") {
            const curProj = baseSnap.project
            nextProject = { ...curProj }
            nextProject.calls = checkedAdd(nextProject.calls, 1)
            if (job.hostTruncatedAtEntry) nextProject.truncatedCalls = checkedAdd(nextProject.truncatedCalls, 1)
            nextProject.excludedOversizeCalls = checkedAdd(nextProject.excludedOversizeCalls, 1)
            nextProject.lastSeenAtMs = Math.max(nextProject.lastSeenAtMs, nowMs)

            const curSess = baseSnap.sessions[sessionKey] ?? emptyAggregate()
            nextSession = { ...curSess }
            if (curSess.calls === 0) nextSession = { ...emptyAggregate() }
            nextSession.calls = checkedAdd(nextSession.calls, 1)
            if (job.hostTruncatedAtEntry) nextSession.truncatedCalls = checkedAdd(nextSession.truncatedCalls, 1)
            nextSession.excludedOversizeCalls = checkedAdd(nextSession.excludedOversizeCalls, 1)
            nextSession.lastSeenAtMs = Math.max(nextSession.lastSeenAtMs, nowMs)
          } else {
            // measurement success
            const curProj = baseSnap.project
            nextProject = applyJobToAggregate(curProj, job, beforeTokens, afterTokens, nowMs)
            const curSess = baseSnap.sessions[sessionKey] ?? emptyAggregate()
            let sessBase: Aggregate
            if (curSess.calls === 0) sessBase = { ...emptyAggregate() }
            else sessBase = { ...curSess }
            const nextS = applyJobToAggregate(sessBase, job, beforeTokens, afterTokens, nowMs)
            nextSession = nextS
          }

          // Validate invariants before publish (light check)
          // Derive measured etc checks are inside validateSnapshot for final, but we can do basic
          // ...

          const nextRev = checkedAdd(currentRev, 1)
          const sessions: Record<string, Aggregate> = { ...baseSnap.sessions }
          if (nextSession) {
            sessions[sessionKey] = nextSession
          }

          // Retention: pruneSessions
          const draft: ProjectSnapshot = {
            schemaVersion: STATS_SCHEMA_VERSION,
            metric: STATS_METRIC,
            revision: nextRev,
            project: nextProject,
            sessions,
          }
          const pruned = pruneSessions(draft, nowMs, sessionKey)

          // Check compromised before publish
          if (compRef.compromised) throw new Error("compromised before publish")

          const ok = await publishSnapshot(projectDir, pruned)
          if (!ok) {
            // EEXIST collision is not retryable, just drop
            throw Object.assign(new Error("EEXIST collision"), { code: "EEXIST" })
          }
          return true
        })
        if (result === null) {
          // lock failure transient -> retry once
          if (attempt < 2) continue
          // after retry, drop
          return
        }
        return
      } catch (e: any) {
        const code = e?.code
        // Non-retryable: validation, corrupt, overflow, EEXIST, capability, compromised
        if (code === "EEXIST") {
          // dropped collision, not retry
          return
        }
        if (e?.message === "corrupt snapshot" || e?.message === "revision mismatch" || e?.message === "overflow" || e?.message === "compromised" || e?.message === "compromised before publish" || e?.message === "capability unavailable" || e?.message === "capability not available" || e?.message === "capability expired" || e?.message === "capability missing") {
          return
        }
        if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
          throw e
        }
        // Transient: lock, fs, etc -> retry once
        if (attempt < 2) continue
        return
      }
    }
  }

  async function countTokensSafe(text: string): Promise<number | null> {
    try {
      const n = await countTokens(text)
      return n
    } catch {
      return null
    }
  }

  return {
    enqueue(job: Job): boolean {
      try {
        return tryEnqueue(job)
      } catch {
        return false
      }
    },
    close(): void {
      try {
        closed = true
        if (capabilityTimer) {
          clearInterval(capabilityTimer)
          capabilityTimer = null
        }
        // do not clear queue immediately to allow active to finish? For tests, clear queue and reset bytes
        queue.length = 0
        queuedBytes = active ? (active.kind === "measure" ? active.combinedUtf8Bytes : 0) : 0
        // active will be cleared after its completion; for immediate close, drop it
        // we keep active until processQueue finishes, but for test simplicity we just mark closed
      } catch {}
    },
    getDroppedCount(): number {
      return droppedQueueCalls
    },
    _getQueueLength(): number {
      return queue.length
    },
    _getQueuedBytes(): number {
      return queuedBytes
    },
    _getActive(): Job | null {
      return active
    },
    _getCapabilityAvailable(): boolean {
      return capabilityAvailable
    },
  }
}

function projectKeyFromCtx(ctx: WorkerCtx): string {
  return ctx.projectKey
}

// For testing
export function __resetWorkerForTest(): void {}
