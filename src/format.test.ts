import { describe, expect, test } from "bun:test"
import { applyLspOutput } from "./format"

const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
const hook = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }

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
})
