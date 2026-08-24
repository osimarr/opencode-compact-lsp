import { describe, expect, test } from "bun:test"
import { emptyAggregate, deriveSaved, deriveCompressionPercent } from "./contract"

describe("stats contract", () => {
  test("empty aggregate has zero tokens and null compression", () => {
    const a = emptyAggregate()
    expect(deriveSaved(a)).toBe(0)
    expect(deriveCompressionPercent(a)).toBe(null)
    expect(a.calls).toBe(0)
  })
  test("derived saved and rate from sums", () => {
    expect(
      deriveSaved({
        calls: 1,
        beforeTokens: 100,
        afterTokens: 30,
        truncatedCalls: 0,
        passThroughCalls: 0,
        excludedOversizeCalls: 0,
        tokenizerErrorCalls: 0,
        lastSeenAtMs: 1,
      } as any),
    ).toBe(70)
    expect(
      deriveCompressionPercent({
        calls: 1,
        beforeTokens: 100,
        afterTokens: 30,
        truncatedCalls: 0,
        passThroughCalls: 0,
        excludedOversizeCalls: 0,
        tokenizerErrorCalls: 0,
        lastSeenAtMs: 1,
      } as any),
    ).toBeCloseTo(70)
  })
})
