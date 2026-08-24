import { STATS_SCHEMA_VERSION, STATS_METRIC, type Aggregate } from "./contract"
import { hasDuplicateKeys } from "./json-dup"

export type ProjectSnapshot = {
  schemaVersion: typeof STATS_SCHEMA_VERSION
  metric: typeof STATS_METRIC
  revision: number
  project: Aggregate
  sessions: Record<string, Aggregate>
}

// ---- validation helpers ----

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isSafeNonnegativeInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
}

const AGGREGATE_KEYS = [
  "calls",
  "beforeTokens",
  "afterTokens",
  "truncatedCalls",
  "passThroughCalls",
  "excludedOversizeCalls",
  "tokenizerErrorCalls",
  "lastSeenAtMs",
] as const

function isValidAggregateStructure(obj: unknown): obj is Aggregate {
  if (!isPlainObject(obj)) return false
  const keys = Object.keys(obj)
  if (keys.length !== AGGREGATE_KEYS.length) return false
  const expected = new Set<string>(AGGREGATE_KEYS as unknown as string[])
  for (const k of keys) if (!expected.has(k)) return false
  for (const k of AGGREGATE_KEYS) if (!(k in obj)) return false
  for (const k of AGGREGATE_KEYS) {
    const v = (obj as Record<string, unknown>)[k]
    if (!isSafeNonnegativeInteger(v)) return false
  }
  return true
}

function isValidAggregateInvariants(agg: Aggregate): boolean {
  // calls == observedCalls; truncated <= observed
  if (agg.truncatedCalls > agg.calls) return false
  // excluded + error <= observed (so derived measuredCalls >=0)
  // Use safe addition check: if sum would overflow, it's invalid
  const sumExcludedError = agg.excludedOversizeCalls + agg.tokenizerErrorCalls
  if (!Number.isSafeInteger(sumExcludedError)) return false
  if (sumExcludedError > agg.calls) return false
  const derivedMeasured = agg.calls - sumExcludedError // = measuredCalls
  if (!Number.isSafeInteger(derivedMeasured) || derivedMeasured < 0) return false
  if (agg.passThroughCalls > derivedMeasured) return false
  // if derivedMeasured (measuredCalls) ===0 then beforeTokens and afterTokens must be 0
  if (derivedMeasured === 0) {
    if (agg.beforeTokens !== 0 || agg.afterTokens !== 0) return false
  }
  // if observedCalls (calls) ===0 then all must be zero (covers above but also truncated etc)
  if (agg.calls === 0) {
    if (
      agg.beforeTokens !== 0 ||
      agg.afterTokens !== 0 ||
      agg.truncatedCalls !== 0 ||
      agg.passThroughCalls !== 0 ||
      agg.excludedOversizeCalls !== 0 ||
      agg.tokenizerErrorCalls !== 0 ||
      agg.lastSeenAtMs !== 0
    )
      return false
  }
  return true
}

export function validateSnapshot(json: string): { ok: true; value: ProjectSnapshot } | { ok: false } {
  if (typeof json !== "string") return { ok: false }
  // duplicate detection
  try {
    if (hasDuplicateKeys(json)) return { ok: false }
  } catch {
    // tokenize failed due to invalid json -> will be caught by JSON.parse below
    // Do not return duplicate false here; let JSON.parse handle
    // But if tokenize threw, we still want to return false overall, but we continue to parse check
    // For now, continue
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false }
  }
  if (!isPlainObject(raw)) return { ok: false }
  const topKeys = Object.keys(raw)
  const expectedTop = new Set(["schemaVersion", "metric", "revision", "project", "sessions"])
  if (topKeys.length !== 5) return { ok: false }
  for (const k of topKeys) if (!expectedTop.has(k)) return { ok: false }
  // schemaVersion/metrics
  if (raw.schemaVersion !== STATS_SCHEMA_VERSION) return { ok: false }
  if (raw.metric !== STATS_METRIC) return { ok: false }
  if (!isSafeNonnegativeInteger(raw.revision) || (raw.revision as number) <= 0) return { ok: false }

  // project
  if (!isValidAggregateStructure(raw.project)) return { ok: false }
  const project = raw.project as Aggregate
  if (!isValidAggregateInvariants(project)) return { ok: false }

  // sessions
  if (!isPlainObject(raw.sessions)) return { ok: false }
  const sessionKeys = Object.keys(raw.sessions)
  if (sessionKeys.length > 256) return { ok: false }
  for (const k of sessionKeys) {
    if (!/^[0-9a-f]{64}$/.test(k)) return { ok: false }
  }
  for (const k of sessionKeys) {
    const agg = (raw.sessions as Record<string, unknown>)[k]
    if (!isValidAggregateStructure(agg)) return { ok: false }
    const a = agg as Aggregate
    if (!isValidAggregateInvariants(a)) return { ok: false }
    if (a.calls === 0) return { ok: false }
    if (a.lastSeenAtMs > project.lastSeenAtMs) return { ok: false }
  }

  // zero project special case
  if (project.calls === 0) {
    if (
      project.beforeTokens !== 0 ||
      project.afterTokens !== 0 ||
      project.truncatedCalls !== 0 ||
      project.passThroughCalls !== 0 ||
      project.excludedOversizeCalls !== 0 ||
      project.tokenizerErrorCalls !== 0 ||
      project.lastSeenAtMs !== 0
    )
      return { ok: false }
    if ((raw.revision as number) !== 1) return { ok: false }
    if (sessionKeys.length !== 0) return { ok: false }
  }

  // sum invariants: checked sums across sessions <= project for each additive field
  const additiveFields: (keyof Aggregate)[] = [
    "calls",
    "beforeTokens",
    "afterTokens",
    "truncatedCalls",
    "passThroughCalls",
    "excludedOversizeCalls",
    "tokenizerErrorCalls",
  ]
  for (const field of additiveFields) {
    let sum = 0
    for (const k of sessionKeys) {
      const v = ((raw.sessions as Record<string, Aggregate>)[k] as Aggregate)[field]
      const next = sum + v
      if (!Number.isSafeInteger(next) || next < 0 || next > Number.MAX_SAFE_INTEGER) return { ok: false }
      sum = next
      if (sum > project[field]) return { ok: false }
    }
  }

  return { ok: true, value: raw as ProjectSnapshot }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export function pruneSessions(
  snap: ProjectSnapshot,
  nowMs: number,
  currentSessionKey?: string,
): ProjectSnapshot {
  const sessions = snap.sessions
  const keys = Object.keys(sessions)

  // Age prune: keep current always, otherwise remove if nowMs > lastSeen and diff > 30 days
  const afterAge: Record<string, Aggregate> = {}
  for (const k of keys) {
    const agg = sessions[k]!
    if (k === currentSessionKey) {
      afterAge[k] = agg
      continue
    }
    if (nowMs > agg.lastSeenAtMs && nowMs - agg.lastSeenAtMs > THIRTY_DAYS_MS) {
      continue
    }
    afterAge[k] = agg
  }

  const afterAgeKeys = Object.keys(afterAge)
  if (afterAgeKeys.length <= 256) {
    return {
      schemaVersion: snap.schemaVersion,
      metric: snap.metric,
      revision: snap.revision,
      project: snap.project,
      sessions: afterAge,
    }
  }

  // Cap pruning: remove oldest non-current until 256
  const nonCurrent: Array<[string, Aggregate]> = []
  const currentEntries: Array<[string, Aggregate]> = []
  for (const k of afterAgeKeys) {
    const agg = afterAge[k]!
    if (k === currentSessionKey) currentEntries.push([k, agg])
    else nonCurrent.push([k, agg])
  }
  nonCurrent.sort((a, b) => {
    if (a[1].lastSeenAtMs !== b[1].lastSeenAtMs) return a[1].lastSeenAtMs - b[1].lastSeenAtMs
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  const toRemove = afterAgeKeys.length - 256
  const keepSet = new Set(nonCurrent.slice(toRemove).map(([k]) => k))
  const finalSessions: Record<string, Aggregate> = {}
  for (const [k, agg] of currentEntries) finalSessions[k] = agg
  for (const [k, agg] of nonCurrent) if (keepSet.has(k)) finalSessions[k] = agg
  return {
    schemaVersion: snap.schemaVersion,
    metric: snap.metric,
    revision: snap.revision,
    project: snap.project,
    sessions: finalSessions,
  }
}
