export const STATS_SCHEMA_VERSION = "stats-v1" as const
export const STATS_METRIC = "o200k_base:gpt-tokenizer@4.0.0:v1" as const
/**
 * Aggregate shape per ADR 0001 v1.
 * ADR defines `observedCalls`/`measuredCalls` but persistence uses `calls` as observedCalls
 * with derived measuredCalls = calls - excludedOversizeCalls - tokenizerErrorCalls.
 * This keeps v1 snapshots compatible (no migration) while honoring the algebra:
 * observedCalls (=calls) = measuredCalls + excludedOversizeCalls + tokenizerErrorCalls
 */
export type Aggregate = {
  /** observedCalls per ADR — increments once per admitted job */
  calls: number
  beforeTokens: number
  afterTokens: number
  truncatedCalls: number
  passThroughCalls: number
  excludedOversizeCalls: number
  tokenizerErrorCalls: number
  lastSeenAtMs: number
}
export function emptyAggregate(): Aggregate {
  return {
    calls: 0,
    beforeTokens: 0,
    afterTokens: 0,
    truncatedCalls: 0,
    passThroughCalls: 0,
    excludedOversizeCalls: 0,
    tokenizerErrorCalls: 0,
    lastSeenAtMs: 0,
  }
}
export function deriveSaved(a: Aggregate): number {
  return a.beforeTokens - a.afterTokens
}
export function deriveCompressionPercent(a: Aggregate): number | null {
  return a.beforeTokens > 0 ? ((a.beforeTokens - a.afterTokens) / a.beforeTokens) * 100 : null
}
export function deriveMeasuredCalls(a: Aggregate): number {
  return a.calls - a.excludedOversizeCalls - a.tokenizerErrorCalls
}
export function deriveObservedCalls(a: Aggregate): number {
  return a.calls
}
