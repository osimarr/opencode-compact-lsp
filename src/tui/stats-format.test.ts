import { describe, expect, test } from "bun:test"
import { formatTokens, formatCompression, formatHeader } from "./stats-format"

describe("stats-format", () => {
  test("formatTokens zero is 0", () => {
    expect(formatTokens(0)).toBe("0")
  })
  test("formatTokens positive small", () => {
    expect(formatTokens(320)).toBe("320")
  })
  test("formatTokens positive K", () => {
    expect(formatTokens(12400)).toBe("12.4K")
  })
  test("formatTokens positive M", () => {
    expect(formatTokens(1_800_000)).toBe("1.8M")
  })
  test("formatTokens negative", () => {
    expect(formatTokens(-320)).toBe("−320")
    expect(formatTokens(-1200)).toBe("−1.2K")
  })
  test("formatCompression null is em dash", () => {
    expect(formatCompression(null)).toBe("—")
  })
  test("formatCompression zero is 0.0%", () => {
    expect(formatCompression(0)).toBe("0.0%")
  })
  test("formatCompression positive", () => {
    expect(formatCompression(64.94)).toBe("64.9%")
    expect(formatCompression(70)).toBe("70.0%")
  })
  test("formatCompression negative", () => {
    expect(formatCompression(-5.12)).toBe("−5.1%")
  })
  test("formatHeader returns headline", () => {
    expect(formatHeader()).toBe("LSP compaction (estimate)")
  })
})
