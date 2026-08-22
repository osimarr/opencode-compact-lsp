import { describe, expect, test } from "bun:test"
import { compactValue } from "./compact"

describe("compactValue", () => {
  test("LocationLink drops extra ranges and file://", () => {
    expect(compactValue([{
      originSelectionRange: { start: { line: 246, character: 47 }, end: { line: 246, character: 54 } },
      targetUri: "file:///home/david/src/tool/lsp.ts",
      targetRange: { start: { line: 36, character: 0 }, end: { line: 111, character: 1 } },
      targetSelectionRange: { start: { line: 36, character: 13 }, end: { line: 36, character: 20 } },
    }])).toEqual([{ path: "/home/david/src/tool/lsp.ts", line: 37, column: 14, end_line: 37, end_column: 21 }])
  })
  test("hover unwraps MarkupContent", () => {
    expect(compactValue([{
      contents: { kind: "markdown", value: "const X: 1" },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }])).toEqual([{ contents: "const X: 1" }])
  })
  test("documentSymbol uses kind names and drops selectionRange", () => {
    const out = compactValue([{
      name: "LspTool",
      kind: 14,
      detail: "const",
      range: { start: { line: 36, character: 0 }, end: { line: 111, character: 1 } },
      selectionRange: { start: { line: 36, character: 13 }, end: { line: 36, character: 20 } },
      children: [{
        name: "execute",
        kind: 6,
        range: { start: { line: 45, character: 8 }, end: { line: 110, character: 11 } },
        selectionRange: { start: { line: 45, character: 16 }, end: { line: 45, character: 23 } },
      }],
    }])
    expect(out).toEqual([{
      name: "LspTool",
      kind: "Constant",
      line: 37,
      column: 14,
      children: [{ name: "execute", kind: "Method", line: 46, column: 17 }],
    }])
  })
  test("dedups identical locations", () => {
    const loc = { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
    expect(compactValue([loc, loc])).toEqual([{ path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 }])
  })
  test("filters null client slots", () => {
    expect(compactValue([null, { contents: "x" }])).toEqual([{ contents: "x" }])
  })
})
