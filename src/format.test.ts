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
})
