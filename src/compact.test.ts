import { describe, expect, test } from "bun:test"
import { compactValue } from "./compact"
import {
  KIND_NAMES,
  callHierarchyItem,
  flatDocumentSymbols,
  hoverMarkup,
  hoverNullSlot,
  incomingCall,
  location,
  outgoingCall,
  symbolInformation,
} from "./fixtures/lsp"

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

  describe("kinds", () => {
    const selectionRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }

    test("maps DocumentSymbol kinds 1-26 to KIND_NAMES", () => {
      expect(KIND_NAMES).toHaveLength(26)
      for (let n = 1; n <= 26; n++) {
        expect(compactValue({ name: "X", kind: n, selectionRange })).toEqual({
          name: "X",
          kind: KIND_NAMES[n - 1],
          line: 1,
          column: 1,
        })
      }
    })

    test("stringifies kinds outside 1-26", () => {
      expect(compactValue({ name: "X", kind: 0, selectionRange })).toEqual({ name: "X", kind: "0", line: 1, column: 1 })
      expect(compactValue({ name: "X", kind: 27, selectionRange })).toEqual({ name: "X", kind: "27", line: 1, column: 1 })
      expect(compactValue({ name: "X", kind: "14", selectionRange })).toEqual({ name: "X", kind: "14", line: 1, column: 1 })
    })
  })

  describe("locations", () => {
    test("Location strips file:// and 1-indexes the range", () => {
      expect(compactValue(location("file:///a.ts", 0, 0, 2, 4))).toEqual({
        path: "/a.ts",
        line: 1,
        column: 1,
        end_line: 3,
        end_column: 5,
      })
    })

    test("LocationLink without targetSelectionRange uses targetRange", () => {
      expect(compactValue({
        targetUri: "file:///a.ts",
        targetRange: { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } },
      })).toEqual({
        path: "/a.ts",
        line: 1,
        column: 1,
        end_line: 3,
        end_column: 5,
      })
    })

    test("decodes %20 in file URIs", () => {
      expect(compactValue(location("file:///tmp/a%20b.ts", 0, 0, 0, 1))).toEqual({
        path: "/tmp/a b.ts",
        line: 1,
        column: 1,
        end_line: 1,
        end_column: 2,
      })
    })

    test("keeps malformed percent escapes", () => {
      expect(compactValue(location("file:///tmp/a%ZZb.ts", 0, 0, 0, 1))).toEqual({
        path: "/tmp/a%ZZb.ts",
        line: 1,
        column: 1,
        end_line: 1,
        end_column: 2,
      })
    })

    test("Windows file URI keeps the drive slash", () => {
      expect(compactValue(location("file:///C:/Users/a.ts", 0, 0, 0, 1))).toEqual({
        path: "/C:/Users/a.ts",
        line: 1,
        column: 1,
        end_line: 1,
        end_column: 2,
      })
    })

    test("untitled URI is unchanged", () => {
      expect(compactValue(location("untitled:Untitled-1", 0, 0, 0, 1))).toEqual({
        path: "untitled:Untitled-1",
        line: 1,
        column: 1,
        end_line: 1,
        end_column: 2,
      })
    })

    test("FILE:// scheme is not stripped", () => {
      expect(compactValue(location("FILE:///home/a.ts", 0, 0, 0, 1))).toEqual({
        path: "FILE:///home/a.ts",
        line: 1,
        column: 1,
        end_line: 1,
        end_column: 2,
      })
    })
  })

  describe("hover", () => {
    test("string contents stay a string", () => {
      expect(compactValue({ contents: "plain" })).toEqual({ contents: "plain" })
    })

    test("MarkedString language/value unwraps to value", () => {
      expect(compactValue({ contents: { language: "typescript", value: "const x = 1" } })).toEqual({
        contents: "const x = 1",
      })
    })

    test("MarkedString array joins with blank lines", () => {
      expect(compactValue({ contents: ["hello", { language: "ts", value: "world" }] })).toEqual({
        contents: "hello\n\nworld",
      })
    })

    test("all-null client slots become an empty array", () => {
      expect(compactValue([null])).toEqual([])
    })

    test("null slot plus hover keeps one hover", () => {
      expect(compactValue(hoverNullSlot)).toEqual([{ contents: "const X: 1" }])
      expect(compactValue(hoverMarkup)).toEqual([{ contents: "const X: 1" }])
    })
  })

  describe("symbols", () => {
    test("SymbolInformation takes path from location.uri and drops containerName", () => {
      expect(compactValue(symbolInformation)).toEqual({
        name: "LspTool",
        kind: "Constant",
        path: "/home/david/src/tool/lsp.ts",
        line: 37,
        column: 14,
      })
    })

    test("nests flat SymbolInformation by containerName", () => {
      expect(compactValue(flatDocumentSymbols)).toEqual([{
        name: "LspTool",
        kind: "Constant",
        path: "/home/david/src/tool/lsp.ts",
        line: 37,
        column: 1,
        children: [{
          name: "execute",
          kind: "Method",
          path: "/home/david/src/tool/lsp.ts",
          line: 46,
          column: 9,
        }],
      }])
    })

    test("empty children are omitted", () => {
      expect(compactValue({
        name: "X",
        kind: 5,
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        children: [],
      })).toEqual({ name: "X", kind: "Class", line: 1, column: 1 })
    })

    test("CallHierarchyItem is a symbol with path and no end_line", () => {
      expect(compactValue(callHierarchyItem)).toEqual({
        name: "execute",
        kind: "Method",
        path: "/home/david/src/tool/lsp.ts",
        line: 46,
        column: 17,
      })
    })

    test("IncomingCall unwraps from", () => {
      expect(compactValue(incomingCall)).toEqual({
        name: "execute",
        kind: "Method",
        path: "/home/david/src/tool/lsp.ts",
        line: 46,
        column: 17,
      })
    })

    test("OutgoingCall unwraps to", () => {
      expect(compactValue(outgoingCall)).toEqual({
        name: "execute",
        kind: "Method",
        path: "/home/david/src/tool/lsp.ts",
        line: 46,
        column: 17,
      })
    })

    test("from wins over to when both are present", () => {
      const from = {
        name: "A",
        kind: 12,
        uri: "file:///a.ts",
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      }
      const to = {
        name: "B",
        kind: 6,
        uri: "file:///b.ts",
        selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
      }
      expect(compactValue({ from, to })).toEqual({
        name: "A",
        kind: "Function",
        path: "/a.ts",
        line: 1,
        column: 1,
      })
    })
  })

  describe("dedup", () => {
    test("Locations that share start but differ in end collapse to one", () => {
      expect(compactValue([
        location("file:///a.ts", 0, 0, 0, 1),
        location("file:///a.ts", 0, 0, 5, 10),
      ])).toEqual([{ path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 }])
    })

    test("empty array stays empty", () => {
      expect(compactValue([])).toEqual([])
    })
  })

  describe("workspaceSymbol uri-only", () => {
    test("uri-only location is not a symbol; kind stays numeric", () => {
      expect(compactValue({
        name: "Foo",
        kind: 5,
        location: { uri: "file:///a.ts" },
      })).toEqual({
        name: "Foo",
        kind: 5,
        location: { uri: "file:///a.ts" },
      })
    })
  })
})
