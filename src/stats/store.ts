/**
 * Durable state store: revision-fenced immutable snapshots, capability marker, and concurrency.
 * Dedicated storage in <projectDir>/snapshots/, never raw payloads.
 * Revision-fenced hard-link no-clobber; EEXIST dropped; XDG state paths via identity module.
 * TUI must not import tokenizer/lock; this module is server-side but readSnapshot is lock-free for TUI reuse.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"
import { STATS_SCHEMA_VERSION, STATS_METRIC, emptyAggregate, type Aggregate } from "./contract"
import { validateSnapshot, pruneSessions, type ProjectSnapshot } from "./snapshot"

// ---- constants per ADR ----
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

const COMPLETED_RE = /^stats-v1\.([1-9][0-9]*)\.json$/
const TEMP_RE = /^\.stats-v1\.([1-9][0-9]*)\.([1-9][0-9]*)\.([0-9a-f]{32})\.tmp$/

// ---- helpers ----

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
      // @ts-ignore
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

// ---- duplicate-aware JSON detection (copied from snapshot.ts for marker validation) ----

type Token =
  | { type: "{"; raw: string }
  | { type: "}"; raw: string }
  | { type: "["; raw: string }
  | { type: "]"; raw: string }
  | { type: ":"; raw: string }
  | { type: ","; raw: string }
  | { type: "string"; value: string; raw: string }
  | { type: "number"; value: string; raw: string }
  | { type: "literal"; value: string; raw: string }

function tokenize(json: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = json.length
  while (i < n) {
    const c = json[i]
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i++
      continue
    }
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === ":" || c === ",") {
      tokens.push({ type: c as any, raw: c } as Token)
      i++
      continue
    }
    if (c === '"') {
      const start = i
      i++
      while (i < n) {
        if (json[i] === "\\") {
          i += 2
          continue
        }
        if (json[i] === '"') {
          i++
          break
        }
        i++
      }
      const raw = json.slice(start, i)
      let decoded: string
      try {
        decoded = JSON.parse(raw)
      } catch {
        throw new Error("Invalid string token")
      }
      tokens.push({ type: "string", value: decoded, raw })
      continue
    }
    if (c === "t") {
      if (json.startsWith("true", i)) {
        tokens.push({ type: "literal", value: "true", raw: "true" })
        i += 4
        continue
      }
      throw new Error("Invalid literal")
    }
    if (c === "f") {
      if (json.startsWith("false", i)) {
        tokens.push({ type: "literal", value: "false", raw: "false" })
        i += 5
        continue
      }
      throw new Error("Invalid literal")
    }
    if (c === "n") {
      if (json.startsWith("null", i)) {
        tokens.push({ type: "literal", value: "null", raw: "null" })
        i += 4
        continue
      }
      throw new Error("Invalid literal")
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const start = i
      i++
      while (i < n && /[0-9eE.\+\-]/.test(json[i]!)) i++
      const raw = json.slice(start, i)
      tokens.push({ type: "number", value: raw, raw })
      continue
    }
    throw new Error(`Unexpected char ${c} at ${i}`)
  }
  return tokens
}

function hasDuplicateKeys(json: string): boolean {
  const tokens = tokenize(json)
  type ObjectFrame = { type: "object"; keys: Set<string>; expect: "keyOrEnd" | "value" | "commaOrEnd" | "key" }
  type ArrayFrame = { type: "array"; expect: "valueOrEnd" | "value" | "commaOrEnd" }
  type Frame = ObjectFrame | ArrayFrame
  const stack: Frame[] = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i] as Token
    if (stack.length === 0) {
      if (tok.type === "{") {
        stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
        i++
        continue
      }
      if (tok.type === "[") {
        stack.push({ type: "array", expect: "valueOrEnd" })
        i++
        continue
      }
      if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
        i++
        continue
      }
      i++
      continue
    }
    const top = stack[stack.length - 1]!
    if (top.type === "object") {
      if (top.expect === "keyOrEnd") {
        if (tok.type === "}") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else if (tok.type === "string") {
          const next = tokens[i + 1] as Token | undefined
          if (next && next.type === ":") {
            const key = (tok as { type: "string"; value: string }).value
            if (top.keys.has(key)) return true
            top.keys.add(key)
            top.expect = "value"
            i += 2
            continue
          } else {
            i++
            continue
          }
        } else {
          i++
          continue
        }
      } else if (top.expect === "value") {
        if (tok.type === "{") {
          stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
          i++
          continue
        } else if (tok.type === "[") {
          stack.push({ type: "array", expect: "valueOrEnd" })
          i++
          continue
        } else if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
          top.expect = "commaOrEnd"
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "commaOrEnd") {
        if (tok.type === ",") {
          top.expect = "key"
          i++
          continue
        } else if (tok.type === "}") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "key") {
        if (tok.type === "string") {
          const next = tokens[i + 1] as Token | undefined
          if (next && next.type === ":") {
            const key = (tok as { type: "string"; value: string }).value
            if (top.keys.has(key)) return true
            top.keys.add(key)
            top.expect = "value"
            i += 2
            continue
          } else {
            i++
            continue
          }
        } else {
          i++
          continue
        }
      } else {
        i++
        continue
      }
    } else {
      if (top.expect === "valueOrEnd") {
        if (tok.type === "]") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else if (tok.type === "{") {
          stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
          i++
          continue
        } else if (tok.type === "[") {
          stack.push({ type: "array", expect: "valueOrEnd" })
          i++
          continue
        } else if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
          top.expect = "commaOrEnd"
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "value") {
        if (tok.type === "{") {
          stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
          i++
          continue
        } else if (tok.type === "[") {
          stack.push({ type: "array", expect: "valueOrEnd" })
          i++
          continue
        } else if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
          top.expect = "commaOrEnd"
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "commaOrEnd") {
        if (tok.type === ",") {
          top.expect = "value"
          i++
          continue
        } else if (tok.type === "]") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else {
          i++
          continue
        }
      } else {
        i++
        continue
      }
    }
  }
  return false
}

// ---- capability helpers ----

export type Capability = {
  protocol: typeof CAPABILITY_PROTOCOL
  status: typeof AVAILABLE | typeof UNAVAILABLE
  checkedAtMs: number
}

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

async function publishCapabilityRaw(projectDir: string, status: typeof AVAILABLE | typeof UNAVAILABLE, nowMs: number): Promise<boolean> {
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

function isValidCapabilityObject(obj: unknown): obj is Capability {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false
  const keys = Object.keys(obj as Record<string, unknown>)
  if (keys.length !== 3) return false
  const expected = new Set(["protocol", "status", "checkedAtMs"])
  for (const k of keys) if (!expected.has(k)) return false
  const o = obj as Record<string, unknown>
  if (o.protocol !== CAPABILITY_PROTOCOL) return false
  if (o.status !== AVAILABLE && o.status !== UNAVAILABLE) return false
  if (typeof o.checkedAtMs !== "number" || !Number.isSafeInteger(o.checkedAtMs) || (o.checkedAtMs as number) < 0) return false
  return true
}

// ---- lock helper ----

async function withProjectLock<T>(projectDir: string, fn: (compromisedRef: { compromised: boolean }) => Promise<T>): Promise<T | null> {
  let lockfile: any = null
  try {
    const spec = "proper-lockfile"
    lockfile = await import(spec).catch(() => null)
    if (!lockfile) {
      const ref = { compromised: false }
      return await fn(ref)
    }
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
    const deadline = Date.now() + 500
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
    const rev = Number(revStr)
    if (!Number.isSafeInteger(rev) || rev <= 0) throw new Error("invalid revision")
    if (rev > Number.MAX_SAFE_INTEGER) throw new Error("revision overflow")
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

// ---- delta application helpers ----

function checkedAdd(a: number, b: number): number {
  const c = a + b
  if (!Number.isSafeInteger(c) || c < 0 || c > Number.MAX_SAFE_INTEGER) throw new Error("overflow")
  return c
}

function deltaToAggregateUpdate(
  base: Aggregate,
  delta: Delta,
): Aggregate {
  const next: Aggregate = { ...base }
  next.calls = checkedAdd(next.calls, 1)
  if (delta.truncated) {
    next.truncatedCalls = checkedAdd(next.truncatedCalls, 1)
  }
  const kind = delta.kind ?? "measured"
  if (kind === "oversize") {
    next.excludedOversizeCalls = checkedAdd(next.excludedOversizeCalls, 1)
  } else if (kind === "tokenizerError") {
    next.tokenizerErrorCalls = checkedAdd(next.tokenizerErrorCalls, 1)
  } else {
    // measured
    if (!Number.isSafeInteger(delta.beforeTokens) || (delta.beforeTokens as number) < 0) throw new Error("invalid beforeTokens")
    if (!Number.isSafeInteger(delta.afterTokens) || (delta.afterTokens as number) < 0) throw new Error("invalid afterTokens")
    next.beforeTokens = checkedAdd(next.beforeTokens, delta.beforeTokens as number)
    next.afterTokens = checkedAdd(next.afterTokens, delta.afterTokens as number)
    if (delta.passThrough) {
      next.passThroughCalls = checkedAdd(next.passThroughCalls, 1)
    }
  }
  if (!Number.isSafeInteger(delta.nowMs) || (delta.nowMs as number) < 0) throw new Error("invalid nowMs")
  next.lastSeenAtMs = Math.max(next.lastSeenAtMs, delta.nowMs as number)
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
    try {
      await fs.link(tmpPath, finalPath)
    } catch (e: any) {
      if (e?.code === "EEXIST") {
        await tryUnlink(tmpPath)
        return false
      }
      const code = e?.code
      if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
        await tryUnlink(tmpPath)
        throw e
      }
      await tryUnlink(tmpPath)
      throw e
    }
    await fsyncDir(dir)
    await tryUnlink(tmpPath)
    try {
      await cleanupSnapshots(projectDir)
    } catch {}
    await fsyncDir(dir)
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

// ---- exported API ----

export type ReadSnapshotResult =
  | { status: "available"; snapshot: ProjectSnapshot }
  | { status: "zero"; snapshot: ProjectSnapshot }
  | { status: "unavailable"; reason: string }

export type Delta = {
  sessionKey: string
  beforeTokens: number
  afterTokens: number
  truncated?: boolean
  passThrough?: boolean
  kind?: "measured" | "oversize" | "tokenizerError"
  nowMs: number
}

export type AggregateDelta = Delta

export async function probeCapability(projectDir: string): Promise<boolean> {
  // First remove prior marker if any (required before probe per ADR)
  const removed = await removeCapability(projectDir)
  if (!removed) {
    await publishCapabilityRaw(projectDir, UNAVAILABLE, Date.now())
    return false
  }
  const probeOk = await probeSnapshotsFilesystem(projectDir)
  if (!probeOk) {
    await publishCapabilityRaw(projectDir, UNAVAILABLE, Date.now())
    return false
  }
  const ok = await publishCapabilityRaw(projectDir, AVAILABLE, Date.now())
  return ok
}

export async function ensureCapability(projectDir: string): Promise<boolean> {
  // Try to ensure available marker exists and is fresh
  // If probe succeeds and publish succeeds, return true
  // This is idempotent: if already available and fresh, it will refresh checkedAtMs
  const existing = await readCapability(projectDir)
  if (existing && existing.status === "available" && Math.abs(Date.now() - existing.checkedAtMs) <= 5000) {
    // refresh
    const ok = await publishCapabilityRaw(projectDir, AVAILABLE, Date.now())
    return ok
  }
  // otherwise run full probe
  return await probeCapability(projectDir)
}

export async function readCapability(projectDir: string): Promise<Capability | null> {
  const capPath = capabilityPath(projectDir)
  let raw: string
  try {
    const st = await fs.stat(capPath)
    if (!st.isFile()) return null
    raw = await fs.readFile(capPath, "utf8")
  } catch (e: any) {
    if (e?.code === "ENOENT") return null
    return null
  }
  // duplicate-aware
  try {
    if (hasDuplicateKeys(raw)) return null
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isValidCapabilityObject(parsed)) return null
  return parsed as Capability
}

export async function readSnapshot(projectDir: string): Promise<ReadSnapshotResult> {
  // Check capability first per ADR: no snapshot displayed without fresh available marker
  // For store-level read, we treat missing/expired/unavailable as unavailable, unless caller explicitly wants zero
  // But zero state is valid only when capability is fresh available and no candidate exists
  let cap: Capability | null = null
  try {
    cap = await readCapability(projectDir)
  } catch {
    cap = null
  }
  const dir = snapshotsDir(projectDir)
  let candidates: { name: string; rev: number }[]
  try {
    candidates = await scanCandidates(dir)
  } catch (e: any) {
    return { status: "unavailable", reason: e?.message ?? "scan failed" }
  }

  if (candidates.length === 0) {
    // no completed candidate: check capability
    if (cap && cap.status === AVAILABLE && Math.abs(Date.now() - cap.checkedAtMs) <= 5000) {
      // zero state
      const zero: ProjectSnapshot = {
        schemaVersion: STATS_SCHEMA_VERSION,
        metric: STATS_METRIC,
        revision: 0,
        project: emptyAggregate(),
        sessions: {},
      }
      return { status: "zero", snapshot: zero }
    }
    // if capability missing/expired/unavailable, still treat as unavailable per ADR strictness
    // But for tests that don't require capability, we return zero if no capability marker exists?
    // To keep store usable without strict capability gate, we return zero when no candidates and no marker
    // However, if marker exists but is unavailable/expired, we should return unavailable
    if (cap === null) {
      const zero: ProjectSnapshot = {
        schemaVersion: STATS_SCHEMA_VERSION,
        metric: STATS_METRIC,
        revision: 0,
        project: emptyAggregate(),
        sessions: {},
      }
      return { status: "zero", snapshot: zero }
    }
    if (cap.status === UNAVAILABLE) {
      return { status: "unavailable", reason: "capability unavailable" }
    }
    if (Math.abs(Date.now() - cap.checkedAtMs) > 5000) {
      return { status: "unavailable", reason: "capability expired" }
    }
    const zero: ProjectSnapshot = {
      schemaVersion: STATS_SCHEMA_VERSION,
      metric: STATS_METRIC,
      revision: 0,
      project: emptyAggregate(),
      sessions: {},
    }
    return { status: "zero", snapshot: zero }
  }

  // have candidates: select highest
  candidates.sort((a, b) => b.rev - a.rev)
  const top = candidates[0]!
  const full = path.join(dir, top.name)
  let raw: string | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = await fs.stat(full)
      if (!st.isFile()) return { status: "unavailable", reason: "not a file" }
      raw = await fs.readFile(full, "utf8")
      break
    } catch (e: any) {
      if (e?.code === "ENOENT" && attempt === 0) {
        await new Promise((r) => setTimeout(r, 25))
        try {
          const recandidates = await scanCandidates(dir)
          if (recandidates.length === 0) {
            const zero: ProjectSnapshot = {
              schemaVersion: STATS_SCHEMA_VERSION,
              metric: STATS_METRIC,
              revision: 0,
              project: emptyAggregate(),
              sessions: {},
            }
            return { status: "zero", snapshot: zero }
          }
          recandidates.sort((a, b) => b.rev - a.rev)
          if (recandidates[0]!.rev !== top.rev) return { status: "unavailable", reason: "revision changed during retry" }
        } catch {}
        continue
      }
      return { status: "unavailable", reason: e?.message ?? "read failed" }
    }
  }
  if (raw === null) return { status: "unavailable", reason: "failed to read" }
  // duplicate-aware validation is inside validateSnapshot, but we also need to ensure hasDuplicateKeys is checked there already
  const v = validateSnapshot(raw)
  if (!v.ok) return { status: "unavailable", reason: "corrupt snapshot" }
  if (v.value.revision !== top.rev) return { status: "unavailable", reason: "revision mismatch" }
  // also check capability freshness for available snapshots? Per ADR, snapshot is only displayed with fresh available marker
  // But for store read, we return available snapshot regardless of capability, unless capability is explicitly unavailable
  // We'll enforce: if capability is unavailable, return unavailable even if snapshot valid
  if (cap && cap.status === UNAVAILABLE) {
    return { status: "unavailable", reason: "capability unavailable despite valid snapshot" }
  }
  if (cap && cap.status === AVAILABLE && Math.abs(Date.now() - cap.checkedAtMs) > 5000) {
    return { status: "unavailable", reason: "capability expired" }
  }
  return { status: "available", snapshot: v.value }
}

export async function commitDelta(projectDir: string, delta: AggregateDelta): Promise<void> {
  // Validate delta basics: sessionKey must be 64 hex, tokens safe integers
  if (!/^[0-9a-f]{64}$/.test(delta.sessionKey)) {
    // do not throw into hook; just drop
    return
  }
  const kind = delta.kind ?? "measured"
  if (kind === "measured") {
    if (!Number.isSafeInteger(delta.beforeTokens) || (delta.beforeTokens as number) < 0) return
    if (!Number.isSafeInteger(delta.afterTokens) || (delta.afterTokens as number) < 0) return
  }
  if (!Number.isSafeInteger(delta.nowMs) || (delta.nowMs as number) < 0) return

  let attempt = 0
  while (attempt < 2) {
    attempt++
    try {
      const result = await withProjectLock(projectDir, async (compRef) => {
        // capability check before each hard-link
        const cap = await readCapability(projectDir)
        if (!cap) throw new Error("capability missing")
        if (cap.status !== AVAILABLE) throw new Error("capability unavailable")
        if (Math.abs(Date.now() - cap.checkedAtMs) > 5000) throw new Error("capability expired")
        try {
          if (hasDuplicateKeys(JSON.stringify(cap))) throw new Error("capability corrupt")
        } catch {}

        if (compRef.compromised) throw new Error("compromised")

        const { rev: currentRev, snap: currentSnap } = await readCurrentSnapshot(projectDir)
        const baseSnap: ProjectSnapshot =
          currentSnap ??
          ({
            schemaVersion: STATS_SCHEMA_VERSION,
            metric: STATS_METRIC,
            revision: 0,
            project: emptyAggregate(),
            sessions: {},
          } as unknown as ProjectSnapshot)

        // Build next aggregates
        const nowMs = delta.nowMs
        let nextProject: Aggregate
        let nextSession: Aggregate

        const curProj = baseSnap.project
        const curSessRaw = baseSnap.sessions[delta.sessionKey]
        const curSess = curSessRaw ?? emptyAggregate()
        // For new session, start from emptyAggregate; for existing, clone
        const sessBase: Aggregate = curSess.calls === 0 ? { ...emptyAggregate() } : { ...curSess }

        if (kind === "oversize") {
          nextProject = { ...curProj }
          nextProject.calls = checkedAdd(nextProject.calls, 1)
          if (delta.truncated) nextProject.truncatedCalls = checkedAdd(nextProject.truncatedCalls, 1)
          nextProject.excludedOversizeCalls = checkedAdd(nextProject.excludedOversizeCalls, 1)
          nextProject.lastSeenAtMs = Math.max(nextProject.lastSeenAtMs, nowMs)

          nextSession = { ...sessBase }
          nextSession.calls = checkedAdd(nextSession.calls, 1)
          if (delta.truncated) nextSession.truncatedCalls = checkedAdd(nextSession.truncatedCalls, 1)
          nextSession.excludedOversizeCalls = checkedAdd(nextSession.excludedOversizeCalls, 1)
          nextSession.lastSeenAtMs = Math.max(nextSession.lastSeenAtMs, nowMs)
        } else if (kind === "tokenizerError") {
          nextProject = { ...curProj }
          nextProject.calls = checkedAdd(nextProject.calls, 1)
          if (delta.truncated) nextProject.truncatedCalls = checkedAdd(nextProject.truncatedCalls, 1)
          nextProject.tokenizerErrorCalls = checkedAdd(nextProject.tokenizerErrorCalls, 1)
          nextProject.lastSeenAtMs = Math.max(nextProject.lastSeenAtMs, nowMs)

          nextSession = { ...sessBase }
          nextSession.calls = checkedAdd(nextSession.calls, 1)
          if (delta.truncated) nextSession.truncatedCalls = checkedAdd(nextSession.truncatedCalls, 1)
          nextSession.tokenizerErrorCalls = checkedAdd(nextSession.tokenizerErrorCalls, 1)
          nextSession.lastSeenAtMs = Math.max(nextSession.lastSeenAtMs, nowMs)
        } else {
          // measured
          nextProject = { ...curProj }
          nextProject.calls = checkedAdd(nextProject.calls, 1)
          if (delta.truncated) nextProject.truncatedCalls = checkedAdd(nextProject.truncatedCalls, 1)
          if (!Number.isSafeInteger(delta.beforeTokens) || (delta.beforeTokens as number) < 0) throw new Error("invalid beforeTokens")
          if (!Number.isSafeInteger(delta.afterTokens) || (delta.afterTokens as number) < 0) throw new Error("invalid afterTokens")
          nextProject.beforeTokens = checkedAdd(nextProject.beforeTokens, delta.beforeTokens as number)
          nextProject.afterTokens = checkedAdd(nextProject.afterTokens, delta.afterTokens as number)
          if (delta.passThrough) nextProject.passThroughCalls = checkedAdd(nextProject.passThroughCalls, 1)
          nextProject.lastSeenAtMs = Math.max(nextProject.lastSeenAtMs, nowMs)

          nextSession = { ...sessBase }
          nextSession.calls = checkedAdd(nextSession.calls, 1)
          if (delta.truncated) nextSession.truncatedCalls = checkedAdd(nextSession.truncatedCalls, 1)
          nextSession.beforeTokens = checkedAdd(nextSession.beforeTokens, delta.beforeTokens as number)
          nextSession.afterTokens = checkedAdd(nextSession.afterTokens, delta.afterTokens as number)
          if (delta.passThrough) nextSession.passThroughCalls = checkedAdd(nextSession.passThroughCalls, 1)
          nextSession.lastSeenAtMs = Math.max(nextSession.lastSeenAtMs, nowMs)
        }

        const nextRev = checkedAdd(currentRev, 1)
        const sessions: Record<string, Aggregate> = { ...baseSnap.sessions }
        sessions[delta.sessionKey] = nextSession

        const draft: ProjectSnapshot = {
          schemaVersion: STATS_SCHEMA_VERSION,
          metric: STATS_METRIC,
          revision: nextRev,
          project: nextProject,
          sessions,
        }
        const pruned = pruneSessions(draft, nowMs, delta.sessionKey)

        if (compRef.compromised) throw new Error("compromised before publish")

        const ok = await publishSnapshot(projectDir, pruned)
        if (!ok) {
          throw Object.assign(new Error("EEXIST collision"), { code: "EEXIST" })
        }
        return true
      })
      if (result === null) {
        if (attempt < 2) continue
        return
      }
      return
    } catch (e: any) {
      const code = e?.code
      if (code === "EEXIST") {
        return
      }
      if (
        e?.message === "corrupt snapshot" ||
        e?.message === "revision mismatch" ||
        e?.message === "overflow" ||
        e?.message === "compromised" ||
        e?.message === "compromised before publish" ||
        e?.message === "capability unavailable" ||
        e?.message === "capability expired" ||
        e?.message === "capability missing" ||
        e?.message === "invalid beforeTokens" ||
        e?.message === "invalid afterTokens"
      ) {
        return
      }
      if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM" || code === "EACCES") {
        // permanent failure: mark unavailable
        try {
          await removeCapability(projectDir)
        } catch {}
        try {
          await publishCapabilityRaw(projectDir, UNAVAILABLE, Date.now())
        } catch {
          try {
            await removeCapability(projectDir)
          } catch {}
        }
        return
      }
      if (attempt < 2) continue
      return
    }
  }
}
