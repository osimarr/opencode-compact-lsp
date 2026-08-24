import { describe, expect, test } from "bun:test"
import { applyLspOutput } from "./format"
import { callHierarchyItem, documentSymbolTree, flatDocumentSymbols, hoverMarkup, symbolInformation } from "./fixtures/lsp"

const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
const hook = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }

function compactHook(result: unknown) {
  return { title: "t", output: JSON.stringify(result, null, 2), metadata: { result } }
}

describe("applyLspOutput", () => {
  test("both false is identity", () => {
    expect(applyLspOutput({ compact: false, minified: false }, hook)).toBe(hook.output)
  })
  test("minified only strips whitespace from protocol JSON", () => {
    expect(applyLspOutput({ compact: false, minified: true }, hook)).toBe(JSON.stringify(loc))
  })
  test("compact pretty is indented DTO", () => {
    const out = applyLspOutput({ compact: true, minified: false }, hook)
    expect(out).toContain("\n")
    expect(JSON.parse(out)).toEqual([{ path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 }])
  })
  test("compact minified is one line DTO", () => {
    const out = applyLspOutput({ compact: true, minified: true }, hook)
    expect(out.includes("\n")).toBe(false)
    expect(JSON.parse(out)[0].path).toBe("/a.ts")
  })
  test("prefers metadata.result over truncated output string", () => {
    const truncated = { ...hook, output: "[\n  {\n    \"uri\":" }
    expect(JSON.parse(applyLspOutput({ compact: true, minified: true }, truncated))[0].path).toBe("/a.ts")
  })
  test("No results found is left alone", () => {
    const empty = { title: "t", output: "No results found for hover", metadata: { result: [] } }
    expect(applyLspOutput({ compact: true, minified: true }, empty)).toBe(empty.output)
  })
  test("invalid JSON without metadata is left alone", () => {
    const bad = { title: "t", output: "not json", metadata: {} }
    expect(applyLspOutput({ compact: false, minified: true }, bad)).toBe("not json")
  })
  test("parses output JSON when metadata has no result", () => {
    const hook = { title: "t", output: JSON.stringify(loc, null, 2), metadata: {} }
    const out = applyLspOutput({ compact: true, minified: true }, hook)
    expect(JSON.parse(out)).toEqual([{ path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 }])
    expect(hook.metadata).toEqual({})
  })
  test("empty result without prefix stringifies to []", () => {
    const empty = { title: "t", output: "[]", metadata: { result: [] } }
    expect(applyLspOutput({ compact: true, minified: true }, empty)).toBe("[]")
  })
  test("exact No results found is identity", () => {
    const empty = { title: "t", output: "No results found", metadata: { result: [] } }
    expect(applyLspOutput({ compact: true, minified: true }, empty)).toBe("No results found")
  })
  test("leading space does not match No results found prefix", () => {
    const hook = { title: "t", output: " No results found", metadata: { result: loc } }
    const out = applyLspOutput({ compact: true, minified: true }, hook)
    expect(out).not.toBe(hook.output)
    expect(JSON.parse(out)).toEqual([{ path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 }])
  })
  test("substring No results found does not match prefix", () => {
    const hook = { title: "t", output: "Results: No results found for hover", metadata: { result: loc } }
    const out = applyLspOutput({ compact: true, minified: true }, hook)
    expect(out).not.toBe(hook.output)
    expect(JSON.parse(out)).toEqual([{ path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 }])
  })
  test("No results found prefix with non-empty result is identity", () => {
    const hook = { title: "t", output: "No results found for hover", metadata: { result: loc } }
    expect(applyLspOutput({ compact: true, minified: true }, hook)).toBe(hook.output)
  })
  test("truncated output uses metadata.result and leaves metadata identity", () => {
    const snap = structuredClone(loc)
    const metadata = { result: loc, truncated: true, outputPath: "/tmp/x" }
    const metaSnap = structuredClone(metadata)
    const hook = { title: "t", output: '[{"uri":"file:///a.ts",', metadata }
    const out = applyLspOutput({ compact: true, minified: true }, hook)
    expect(JSON.parse(out)).toEqual([{ path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 }])
    expect(hook.metadata).toBe(metadata)
    expect(hook.metadata.result).toBe(loc)
    expect(hook.metadata.result).toEqual(snap)
    expect(hook.metadata).toEqual(metaSnap)
    expect(hook.metadata.truncated).toBe(true)
    expect(hook.metadata.outputPath).toBe("/tmp/x")
  })
  test("both false returns truncated output by identity", () => {
    const truncated = '[{"uri":"file:///a.ts",'
    const hook = { title: "t", output: truncated, metadata: { result: loc, truncated: true, outputPath: "/tmp/x" } }
    expect(applyLspOutput({ compact: false, minified: false }, hook)).toBe(hook.output)
    expect(applyLspOutput({ compact: false, minified: false }, hook)).toBe(truncated)
  })
  test("compact documentSymbol is an indented outline, not JSON", () => {
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(documentSymbolTree))
    expect(out).toBe("37:14 Constant LspTool\n  46:17 Method execute")
  })
  test("flat SymbolInformation documentSymbol nests by containerName", () => {
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(flatDocumentSymbols))
    expect(out).toBe("37:1 Constant LspTool\n  46:9 Method execute")
  })
  test("containerName nesting is three levels deep", () => {
    const tree = [
      { name: "Outer", kind: 5, location: loc[0] },
      {
        name: "mid",
        kind: 6,
        location: { uri: "file:///a.ts", range: { start: { line: 1, character: 2 }, end: { line: 4, character: 1 } } },
        containerName: "Outer",
      },
      {
        name: "inner",
        kind: 7,
        location: { uri: "file:///a.ts", range: { start: { line: 2, character: 4 }, end: { line: 3, character: 5 } } },
        containerName: "mid",
      },
    ]
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(tree))
    expect(out).toBe("1:1 Class Outer\n  2:3 Method mid\n    3:5 Property inner")
  })
  test("workspace symbols in different files keep path", () => {
    const symbols = [
      { name: "Foo", kind: 5, location: { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } } },
      { name: "Bar", kind: 5, location: { uri: "file:///b.ts", range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } } },
    ]
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(symbols))
    expect(out).toBe("1:1 Class Foo /a.ts\n1:1 Class Bar /b.ts")
  })
  test("outline indents each child level by two spaces", () => {
    const tree = [{
      name: "Outer",
      kind: 5,
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      children: [{
        name: "mid",
        kind: 6,
        selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
        children: [{
          name: "inner",
          kind: 7,
          selectionRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 5 } },
        }],
      }],
    }]
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(tree))
    expect(out).toBe("1:1 Class Outer\n  2:3 Method mid\n    3:5 Property inner")
  })
  test("compact pretty documentSymbol is the same outline", () => {
    const out = applyLspOutput({ compact: true, minified: false }, compactHook(documentSymbolTree))
    expect(out).toBe("37:14 Constant LspTool\n  46:17 Method execute")
  })
  test("compact SymbolInformation outline appends path", () => {
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(symbolInformation))
    expect(out).toBe("37:14 Constant LspTool /home/david/src/tool/lsp.ts")
  })
  test("compact hover stays JSON", () => {
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(hoverMarkup))
    expect(JSON.parse(out)).toEqual([{ contents: "const X: 1" }])
  })
  test("empty symbol result stays []", () => {
    expect(applyLspOutput({ compact: true, minified: true }, compactHook([]))).toBe("[]")
  })
  test("mixed symbol and location stays JSON DTO", () => {
    const mixed = [documentSymbolTree[0], loc[0]]
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(mixed))
    expect(JSON.parse(out)).toEqual([
      { name: "LspTool", kind: "Constant", line: 37, column: 14, children: [{ name: "execute", kind: "Method", line: 46, column: 17 }] },
      { path: "/a.ts", line: 1, column: 1, end_line: 1, end_column: 2 },
    ])
  })
  test("newline in symbol name becomes a space", () => {
    const tree = [{
      name: "foo\nbar",
      kind: 12,
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }]
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(tree))
    expect(out).toBe("1:1 Function foo bar")
  })
  test("name with spaces is the rest of the line", () => {
    const tree = [{
      name: "impl Foo for Bar",
      kind: 5,
      selectionRange: { start: { line: 9, character: 4 }, end: { line: 9, character: 8 } },
    }]
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(tree))
    expect(out).toBe("10:5 Class impl Foo for Bar")
  })
  test("compact false documentSymbol stays protocol JSON", () => {
    const out = applyLspOutput({ compact: false, minified: true }, compactHook(documentSymbolTree))
    expect(JSON.parse(out)).toEqual(documentSymbolTree)
  })
  test("compact CallHierarchyItem is a single outline line with path", () => {
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(callHierarchyItem))
    expect(out).toBe("46:17 Method execute /home/david/src/tool/lsp.ts")
  })
  test("uri-only workspace symbol stays JSON", () => {
    const symbol = { name: "Foo", kind: 5, location: { uri: "file:///a.ts" } }
    const out = applyLspOutput({ compact: true, minified: true }, compactHook(symbol))
    expect(JSON.parse(out)).toEqual({ name: "Foo", kind: 5, location: { uri: "file:///a.ts" } })
  })
})
