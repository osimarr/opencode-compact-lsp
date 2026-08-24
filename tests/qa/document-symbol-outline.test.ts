import { describe, expect, test } from "bun:test"
import { applyLspOutput } from "../../src/format"
import fixture from "../fixtures/tsserver-document-symbol.json"

describe("QA: OpenCode-shaped tsserver documentSymbol", () => {
  test("outlines nested symbols instead of a flat list", () => {
    const out = applyLspOutput({ compact: true, minified: true }, {
      title: "t",
      output: JSON.stringify(fixture),
      metadata: { result: fixture },
    })
    const lines = out.split("\n")
    const parent = lines.findIndex((line) => /^\d+:\d+ Function compactValue$/.test(line))
    expect(parent).toBeGreaterThanOrEqual(0)
    const children: string[] = []
    for (const line of lines.slice(parent + 1)) {
      if (!line.startsWith("  ")) break
      children.push(line)
    }
    expect(children.length).toBeGreaterThan(0)
    expect(children.some((line) => /Constant obj$/.test(line))).toBe(true)
    expect(lines.some((line) => line.includes("compact.ts"))).toBe(false)
  })
})
