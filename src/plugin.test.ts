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
  test("does not register a tool", async () => {
    const plugin = await pluginFn({} as never, { compact: true, minified: true })
    expect(plugin.tool).toBeUndefined()
  })
  test("attachments survive rewrite", async () => {
    const plugin = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const attachments = [{ type: "file", mime: "text/plain", url: "file:///x" }]
    const output = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc }, attachments }
    await plugin["tool.execute.after"]!({ tool: "lsp", sessionID: "", callID: "", args: {} }, output)
    expect(JSON.parse(output.output)[0].path).toBe("/a.ts")
    expect(output.attachments).toBe(attachments)
    expect(output.attachments).toEqual([{ type: "file", mime: "text/plain", url: "file:///x" }])
  })
  test("title is unchanged", async () => {
    const plugin = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const output = { title: "keep-title", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    await plugin["tool.execute.after"]!({ tool: "lsp", sessionID: "", callID: "", args: {} }, output)
    expect(output.title).toBe("keep-title")
  })
  test("undefined options still rewrites with defaults", async () => {
    const plugin = await pluginFn({} as never, undefined)
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const output = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    await plugin["tool.execute.after"]!({ tool: "lsp", sessionID: "", callID: "", args: {} }, output)
    expect(JSON.parse(output.output)[0].path).toBe("/a.ts")
  })
  test("does not mutate metadata.result identity", async () => {
    const plugin = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const snap = structuredClone(loc)
    const output = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    await plugin["tool.execute.after"]!({ tool: "lsp", sessionID: "", callID: "", args: {} }, output)
    expect(output.metadata.result).toBe(loc)
    expect(output.metadata.result).toEqual(snap)
  })
  test("truncated wrap fields survive rewrite", async () => {
    const plugin = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const output = {
      title: "t",
      output: '[{"uri":"file:///a.ts",',
      metadata: { result: loc, truncated: true, outputPath: "/tmp/x" },
    }
    await plugin["tool.execute.after"]!({ tool: "lsp", sessionID: "", callID: "", args: {} }, output)
    expect(JSON.parse(output.output)[0].path).toBe("/a.ts")
    expect(output.metadata.result).toBe(loc)
    expect(output.metadata.truncated).toBe(true)
    expect(output.metadata.outputPath).toBe("/tmp/x")
  })
})
