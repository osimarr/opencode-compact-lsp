/**
 * TUI snapshot reader: lock-free, no tokenizer/lock/worker imports.
 * Shared identity module only, watch + 2s poll while mounted, 200ms debounce.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as fssync from "node:fs"
import { resolveStateRoot, canonicalProjectIdentity, deriveProjectKey, deriveSessionKey } from "../stats/identity"
import { validateSnapshot, type ProjectSnapshot } from "../stats/snapshot"
import { emptyAggregate, type Aggregate } from "../stats/contract"

const CAPABILITY_PROTOCOL = "stats-capability-v1" as const
const COMPLETED_RE = /^stats-v1\.([1-9][0-9]*)\.json$/
const transientCodes = new Set(["EINTR", "EAGAIN", "EBUSY"])

// duplicate-aware JSON detection for capability (copied from snapshot/store)
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

function isValidCapabilityObject(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false
  const keys = Object.keys(obj as Record<string, unknown>)
  if (keys.length !== 3) return false
  const expected = new Set(["protocol", "status", "checkedAtMs"])
  for (const k of keys) if (!expected.has(k)) return false
  const o = obj as Record<string, unknown>
  if (o.protocol !== CAPABILITY_PROTOCOL) return false
  if (o.status !== "available" && o.status !== "unavailable") return false
  if (typeof o.checkedAtMs !== "number" || !Number.isSafeInteger(o.checkedAtMs) || (o.checkedAtMs as number) < 0) return false
  return true
}

// ---- global caches for TUI lifecycle ----
const initDeadline = new Map<string, number>() // key -> startMs
const lastGood = new Map<string, { snapshot: ProjectSnapshot; revision: number; project: Aggregate; session: Aggregate | null }>()
const lastAccepted = new Map<string, number>() // projectDir -> checkedAtMs

export function clearReaderState(): void {
  initDeadline.clear()
  lastGood.clear()
  lastAccepted.clear()
}

function deadlineKey(stateRoot: string, canonical: string): string {
  return `${stateRoot}::${canonical}`
}
function lastGoodKey(projectKey: string, sessionKey: string): string {
  return `${projectKey}::${sessionKey}`
}

function isTransient(e: any): boolean {
  const code = e?.code
  return typeof code === "string" && transientCodes.has(code)
}

export type TuiStatus = "initializing" | "unavailable" | "stale" | "ready" | "zero"

export type TuiReadResult = {
  status: TuiStatus
  snapshot: ProjectSnapshot | null
  revision: number | null
  projectAgg: Aggregate | null
  sessionAgg: Aggregate | null
  // for stale, we expose lastGood snapshot
  staleSnapshot?: ProjectSnapshot | null
}

async function readIdentityKey(stateRoot: string): Promise<{ key: Buffer | null; error: string | null; transient: boolean }> {
  const p = path.join(stateRoot, "identity-v1")
  try {
    const st = await fs.stat(p)
    if (!st.isFile()) return { key: null, error: "not a file", transient: false }
    const data = await fs.readFile(p)
    if (data.length !== 32) return { key: null, error: "invalid length", transient: false }
    return { key: Buffer.from(data), error: null, transient: false }
  } catch (e: any) {
    const code = e?.code
    if (code === "ENOENT") return { key: null, error: "missing", transient: false }
    if (isTransient(e)) return { key: null, error: "transient", transient: true }
    return { key: null, error: e?.message ?? "read failed", transient: false }
  }
}

async function hasProjects(stateRoot: string): Promise<boolean> {
  const dir = path.join(stateRoot, "projects")
  try {
    const entries = await fs.readdir(dir)
    return entries.length > 0
  } catch (e: any) {
    if (e?.code === "ENOENT") return false
    // if we can't read, treat as having projects to be safe (orphaned)
    return true
  }
}

async function readCapability(projectDir: string): Promise<{ cap: { protocol: string; status: string; checkedAtMs: number } | null; error: string | null; transient: boolean; raw: string | null }> {
  const p = path.join(projectDir, "capability-v1.json")
  try {
    const st = await fs.stat(p)
    if (!st.isFile()) return { cap: null, error: "not a file", transient: false, raw: null }
    const raw = await fs.readFile(p, "utf8")
    try {
      if (hasDuplicateKeys(raw)) return { cap: null, error: "duplicate", transient: false, raw }
    } catch {
      return { cap: null, error: "duplicate parse failed", transient: false, raw }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { cap: null, error: "invalid json", transient: false, raw }
    }
    if (!isValidCapabilityObject(parsed)) return { cap: null, error: "invalid capability", transient: false, raw }
    return { cap: parsed as any, error: null, transient: false, raw }
  } catch (e: any) {
    const code = e?.code
    if (code === "ENOENT") return { cap: null, error: "missing", transient: false, raw: null }
    if (isTransient(e)) return { cap: null, error: "transient", transient: true, raw: null }
    return { cap: null, error: e?.message ?? "read failed", transient: false, raw: null }
  }
}

async function scanCandidates(snapDir: string): Promise<{ name: string; rev: number }[] | { error: string; transient: boolean }> {
  let entries: string[]
  try {
    entries = await fs.readdir(snapDir)
  } catch (e: any) {
    if (e?.code === "ENOENT") return []
    if (isTransient(e)) return { error: "transient", transient: true }
    return { error: e?.message ?? "readdir failed", transient: false }
  }
  if (entries.length > 512) return { error: "too many entries", transient: false }
  const candidates: { name: string; rev: number }[] = []
  for (const name of entries) {
    const m = COMPLETED_RE.exec(name)
    if (!m) continue
    const revStr = m[1]!
    const rev = Number(revStr)
    if (!Number.isSafeInteger(rev) || rev <= 0) return { error: "invalid revision", transient: false }
    if (rev > Number.MAX_SAFE_INTEGER) return { error: "revision overflow", transient: false }
    if (String(rev) !== revStr) return { error: "non-canonical revision", transient: false }
    candidates.push({ name, rev })
    if (candidates.length > 64) return { error: "too many candidates", transient: false }
  }
  return candidates
}

async function readHighestSnapshot(projectDir: string): Promise<{ snapshot: ProjectSnapshot | null; revision: number | null; raw: string | null; error: string | null; transient: boolean; zero: boolean }> {
  const dir = path.join(projectDir, "snapshots")
  const candRes = await scanCandidates(dir)
  if (Array.isArray(candRes)) {
    // empty or candidates
  } else {
    // error object
    return { snapshot: null, revision: null, raw: null, error: candRes.error, transient: candRes.transient, zero: false }
  }
  const candidates = candRes as { name: string; rev: number }[]
  if (candidates.length === 0) {
    return { snapshot: null, revision: 0, raw: null, error: null, transient: false, zero: true }
  }
  candidates.sort((a, b) => b.rev - a.rev)
  const top = candidates[0]!
  const full = path.join(dir, top.name)
  let raw: string | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const st = await fs.stat(full)
      if (!st.isFile()) return { snapshot: null, revision: null, raw: null, error: "not a file", transient: false, zero: false }
      raw = await fs.readFile(full, "utf8")
      break
    } catch (e: any) {
      if (e?.code === "ENOENT" && attempt === 0) {
        await new Promise((r) => setTimeout(r, 25))
        try {
          const recandidates = await scanCandidates(dir) as any
          if (Array.isArray(recandidates)) {
            if (recandidates.length === 0) return { snapshot: null, revision: 0, raw: null, error: null, transient: false, zero: true }
            recandidates.sort((a: any, b: any) => b.rev - a.rev)
            if (recandidates[0].rev !== top.rev) return { snapshot: null, revision: null, raw: null, error: "revision changed during retry", transient: false, zero: false }
          }
        } catch {}
        continue
      }
      if (isTransient(e)) return { snapshot: null, revision: null, raw: null, error: "transient", transient: true, zero: false }
      return { snapshot: null, revision: null, raw: null, error: e?.message ?? "read failed", transient: false, zero: false }
    }
  }
  if (raw === null) return { snapshot: null, revision: null, raw: null, error: "failed to read", transient: false, zero: false }
  const v = validateSnapshot(raw)
  if (!v.ok) return { snapshot: null, revision: null, raw, error: "corrupt snapshot", transient: false, zero: false }
  if (v.value.revision !== top.rev) return { snapshot: null, revision: null, raw, error: "revision mismatch", transient: false, zero: false }
  return { snapshot: v.value, revision: top.rev, raw, error: null, transient: false, zero: false }
}

export async function readTuiState(opts: { directory: string; sessionId: string; env: NodeJS.ProcessEnv; nowMs?: number }): Promise<TuiReadResult> {
  const nowMs = opts.nowMs ?? Date.now()
  // validate sessionId
  if (typeof opts.sessionId !== "string" || opts.sessionId.length === 0) {
    return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
  }
  let stateRoot: string
  try {
    stateRoot = resolveStateRoot(opts.env)
  } catch {
    return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
  }
  let canonical: string
  try {
    canonical = await canonicalProjectIdentity(opts.directory)
  } catch {
    // fallback to directory normalized
    try {
      const real = await fs.realpath(opts.directory)
      canonical = path.normalize(real)
      const root = path.parse(canonical).root
      if (canonical.length > root.length) {
        while (canonical.length > root.length && canonical.endsWith(path.sep)) canonical = canonical.slice(0, -path.sep.length)
      }
    } catch {
      canonical = path.normalize(opts.directory)
    }
  }
  const dKey = deadlineKey(stateRoot, canonical)
  // identity
  const idRes = await readIdentityKey(stateRoot)
  if (!idRes.key) {
    if (idRes.error === "missing") {
      const hasProj = await hasProjects(stateRoot)
      if (hasProj) {
        // orphaned: immediately unavailable
        initDeadline.delete(dKey)
        return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
      }
      // grace 5s
      let start = initDeadline.get(dKey)
      if (start === undefined) {
        start = nowMs
        initDeadline.set(dKey, start)
      }
      if (nowMs - start <= 5000) {
        return { status: "initializing", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
      } else {
        return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
      }
    }
    if (idRes.transient) {
      // treat as unavailable, but if we have lastGood and within 5s window consider stale?
      // For identity transient, we hide lastGood per spec (invalid identity hides)
      return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
    }
    // malformed
    initDeadline.delete(dKey)
    return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
  }
  // identity valid, derive keys
  const projectKey = deriveProjectKey(idRes.key, canonical)
  const sessionKey = deriveSessionKey(idRes.key, projectKey, opts.sessionId)
  const projectDir = path.join(stateRoot, "projects", projectKey)
  const lgKey = lastGoodKey(projectKey, sessionKey)
  const last = lastGood.get(lgKey) ?? null
  const lastChecked = lastAccepted.get(projectDir) ?? null

  // capability
  const capRes = await readCapability(projectDir)
  if (capRes.cap) {
    const cap = capRes.cap
    if (cap.status === "unavailable") {
      initDeadline.delete(dKey)
      return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
    }
    // available, check freshness
    if (Math.abs(nowMs - cap.checkedAtMs) > 5000) {
      initDeadline.delete(dKey)
      return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
    }
    // fresh available
    initDeadline.delete(dKey)
    lastAccepted.set(projectDir, cap.checkedAtMs)
    // proceed to snapshot
    const snapRes = await readHighestSnapshot(projectDir)
    if (snapRes.error) {
      if (snapRes.transient) {
        // stale if have lastGood and lastAccepted still within 5s
        const age = last ? Math.abs(nowMs - (lastAccepted.get(projectDir) ?? cap.checkedAtMs)) : Infinity
        if (last && age <= 5000) {
          return { status: "stale", snapshot: last.snapshot, revision: last.revision, projectAgg: last.project, sessionAgg: last.session, staleSnapshot: last.snapshot }
        }
        return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
      }
      // corrupt etc -> unavailable hides lastGood
      if (snapRes.error === "corrupt snapshot" || snapRes.error === "revision mismatch" || snapRes.error === "too many entries" || snapRes.error === "too many candidates") {
        // hide lastGood, always unavailable
        return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
      }
      return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
    }
    if (snapRes.zero) {
      const empty = emptyAggregate()
      const result: TuiReadResult = { status: "zero", snapshot: null, revision: 0, projectAgg: empty, sessionAgg: null }
      // store lastGood as zero? For stale we need lastGood, but zero counts as valid lastGood
      // We'll store zero snapshot as synthetic
      const synthetic: ProjectSnapshot = {
        schemaVersion: "stats-v1" as any,
        metric: "o200k_base:gpt-tokenizer@4.0.0:v1" as any,
        revision: 0,
        project: empty,
        sessions: {},
      }
      lastGood.set(lgKey, { snapshot: synthetic, revision: 0, project: empty, session: null })
      return result
    }
    const snap = snapRes.snapshot!
    const rev = snapRes.revision!
    const projectAgg = snap.project
    const sessionAgg = (snap.sessions as Record<string, Aggregate>)[sessionKey] ?? null
    const result: TuiReadResult = { status: "ready", snapshot: snap, revision: rev, projectAgg, sessionAgg }
    // check if revision and status unchanged vs lastGood: caller will handle skip rerender, but we update lastGood
    lastGood.set(lgKey, { snapshot: snap, revision: rev, project: projectAgg, session: sessionAgg })
    return result
  } else {
    // cap missing or error
    if (capRes.error === "missing") {
      let start = initDeadline.get(dKey)
      if (start === undefined) {
        start = nowMs
        initDeadline.set(dKey, start)
      }
      if (nowMs - start <= 5000) {
        return { status: "initializing", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
      } else {
        return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
      }
    }
    if (capRes.transient) {
      const age = last && lastChecked !== null ? Math.abs(nowMs - lastChecked) : Infinity
      if (last && age <= 5000) {
        return { status: "stale", snapshot: last.snapshot, revision: last.revision, projectAgg: last.project, sessionAgg: last.session, staleSnapshot: last.snapshot }
      }
      return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
    }
    // malformed etc
    initDeadline.delete(dKey)
    return { status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null }
  }
}

// ---- watcher / poll helper ----
export function createTuiPoller(opts: {
  directory: string
  sessionId: string
  env: NodeJS.ProcessEnv
  onUpdate: (result: TuiReadResult) => void
}): () => void {
  let disposed = false
  let generation = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: fssync.FSWatcher | null = null
  let lastResult: TuiReadResult | null = null

  const doRead = async () => {
    const g = ++generation
    try {
      const result = await readTuiState({ directory: opts.directory, sessionId: opts.sessionId, env: opts.env })
      if (disposed || g !== generation) return
      // skip rerender when revision and status unchanged
      if (lastResult && lastResult.status === result.status && lastResult.revision === result.revision) {
        return
      }
      lastResult = result
      opts.onUpdate(result)
      // retry watch setup if needed (polling detects first publication)
      if (!watcher) {
        void setupWatch()
      }
    } catch {
      // ignore
    }
  }

  const setupWatch = async () => {
    if (disposed) return
    try {
      // need to derive projectDir to watch; we need stateRoot + projectKey
      // do light derivation without full readTuiState to avoid recursion
      let stateRoot: string
      try {
        stateRoot = resolveStateRoot(opts.env)
      } catch {
        return
      }
      let canonical: string
      try {
        canonical = await canonicalProjectIdentity(opts.directory)
      } catch {
        return
      }
      const idRes = await readIdentityKey(stateRoot)
      if (!idRes.key) return
      const projectKey = deriveProjectKey(idRes.key, canonical)
      const snapshotsDir = path.join(stateRoot, "projects", projectKey, "snapshots")
      // try to watch
      try {
        watcher = fssync.watch(snapshotsDir, () => {
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            void doRead()
          }, 200)
        })
        watcher.on("error", () => {
          try {
            watcher?.close()
          } catch {}
          watcher = null
        })
      } catch {
        // watch setup failure nonfatal
        watcher = null
      }
    } catch {
      // ignore
    }
  }

  // immediate bounded scan/read
  void doRead()
  // poll every 2 seconds for entire mounted lifetime
  pollTimer = setInterval(() => {
    void doRead()
  }, 2000)
  void setupWatch()

  return () => {
    disposed = true
    generation++
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (watcher) {
      try {
        watcher.close()
      } catch {}
      watcher = null
    }
  }
}
