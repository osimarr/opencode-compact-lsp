import { describe, expect, test } from "bun:test"
import pluginFn from "./plugin"

describe("plugin", () => {
  test("ignores non-lsp tools", async () => {
    const plugin = await pluginFn({} as never, { compact: true, minified: true })
    const output = { title: "x", output: "keep", metadata: {} }
    await plugin["tool.execute.after"]!({ tool: "bash", sessionID: "", callID: "", args: {} }, output)
    expect(output.output).toBe("keep")
  })
  test("rewrites lsp output and leaves metadata", async () => {
    const plugin = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const output = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    await plugin["tool.execute.after"]!({ tool: "lsp", sessionID: "", callID: "", args: {} }, output)
    expect(JSON.parse(output.output)[0].path).toBe("/a.ts")
    expect(output.metadata.result).toEqual(loc)
  })
  test("both false does not rewrite", async () => {
    const plugin = await pluginFn({} as never, { compact: false, minified: false })
    const output = { title: "t", output: "pretty", metadata: { result: [] } }
    await plugin["tool.execute.after"]!({ tool: "lsp", sessionID: "", callID: "", args: {} }, output)
    expect(output.output).toBe("pretty")
  })
})
