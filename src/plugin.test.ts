import { afterEach, describe, expect, test } from "bun:test"
import pluginFn from "./plugin"
import {
  __resetRecorderFactoryForTest,
  __resetRecorderForTest,
  __setRecorderFactoryForTest,
  __setRecorderForTest,
} from "./plugin-seams"

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
    expect("tool" in plugin).toBe(false)
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

describe("plugin stats hook (fail-open)", () => {
  afterEach(() => {
    try {
      __resetRecorderForTest()
    } catch {}
    try {
      __resetRecorderFactoryForTest()
    } catch {}
  })

  test("stats on/off leaves output and metadata identical (brief)", async () => {
    const p = await pluginFn({} as any, {})
    const out = {
      title: "t",
      output: JSON.stringify([{ uri: "file:///a", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }], null, 2),
      metadata: { result: [{ uri: "file:///a", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] },
    }
    await p["tool.execute.after"]!({ tool: "lsp", sessionID: "s", callID: "c", args: { operation: "goToDefinition" } } as any, out as any)
    expect(out.metadata.result).toEqual([{ uri: "file:///a", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }])
  })

  test("stats on/off leaves output identical", async () => {
    if (typeof __setRecorderForTest !== "function" || typeof __resetRecorderForTest !== "function") throw new Error("seam missing")
    // off
    __resetRecorderForTest()
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const pretty = JSON.stringify(loc, null, 2)
    const pOff = await pluginFn({} as never, { compact: true, minified: true })
    const outOff = { title: "t", output: pretty, metadata: { result: structuredClone(loc) } }
    await pOff["tool.execute.after"]!({ tool: "lsp", sessionID: "s", callID: "c", args: {} } as any, outOff as any)
    const outputOff = outOff.output
    const metaOff = structuredClone(outOff.metadata)

    // on with spy
    const calls: unknown[][] = []
    __setRecorderForTest({ record: (...args: unknown[]) => calls.push(args), close: () => {} } as any)
    const pOn = await pluginFn({} as never, { compact: true, minified: true })
    const outOn = { title: "t", output: pretty, metadata: { result: structuredClone(loc) } }
    await pOn["tool.execute.after"]!({ tool: "lsp", sessionID: "s", callID: "c", args: {} } as any, outOn as any)

    expect(outOn.output).toBe(outputOff)
    expect(outOn.metadata).toEqual(metaOff)
    expect(calls.length).toBe(1)
    expect(calls[0]![0]).toBe(pretty)
    expect(JSON.parse(calls[0]![1] as string)[0].path).toBe("/a.ts")
    expect(calls[0]![2]).toBe("s")
    expect(calls[0]![3]).toBe(false)
  })

  test("truncated flag captured at entry", async () => {
    if (typeof __setRecorderForTest !== "function") throw new Error("seam missing")
    const calls: unknown[][] = []
    __setRecorderForTest({ record: (...args: unknown[]) => calls.push(args), close: () => {} } as any)
    const p = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const outTrue = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc, truncated: true } }
    await p["tool.execute.after"]!({ tool: "lsp", sessionID: "sess", callID: "c", args: {} } as any, outTrue as any)
    expect(calls[0]![3]).toBe(true)
    calls.length = 0
    const outFalse = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc, truncated: false } }
    await p["tool.execute.after"]!({ tool: "lsp", sessionID: "sess", callID: "c", args: {} } as any, outFalse as any)
    expect(calls[0]![3]).toBe(false)
    const outMissing = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    calls.length = 0
    await p["tool.execute.after"]!({ tool: "lsp", sessionID: "sess", callID: "c", args: {} } as any, outMissing as any)
    expect(calls[0]![3]).toBe(false)
  })

  test("before/after strings are exact entry/exit values", async () => {
    if (typeof __setRecorderForTest !== "function") throw new Error("seam missing")
    const calls: unknown[][] = []
    __setRecorderForTest({ record: (...args: unknown[]) => calls.push(args), close: () => {} } as any)
    const p = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const pretty = JSON.stringify(loc, null, 2)
    const out = { title: "t", output: pretty, metadata: { result: loc } }
    await p["tool.execute.after"]!({ tool: "lsp", sessionID: "s", callID: "c", args: {} } as any, out as any)
    expect(calls[0]![0]).toBe(pretty)
    expect(calls[0]![1]).toBe(out.output)
    expect(out.output).not.toBe(pretty)
  })

  test("hook never throws when recorder throws", async () => {
    if (typeof __setRecorderForTest !== "function") throw new Error("seam missing")
    __setRecorderForTest({ record: () => { throw new Error("boom") }, close: () => {} } as any)
    const p = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const out = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    await expect(p["tool.execute.after"]!({ tool: "lsp", sessionID: "s", callID: "c", args: {} } as any, out as any)).resolves.toBeUndefined()
    expect(JSON.parse(out.output)[0].path).toBe("/a.ts")
    expect(out.metadata.result).toEqual(loc)
  })

  test("factory throw does not break hook", async () => {
    if (typeof __setRecorderFactoryForTest !== "function") throw new Error("seam missing")
    __setRecorderFactoryForTest((() => { throw new Error("factory boom") }) as any)
    const p = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const out = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    await expect(p["tool.execute.after"]!({ tool: "lsp", sessionID: "s", callID: "c", args: {} } as any, out as any)).resolves.toBeUndefined()
    expect(JSON.parse(out.output)[0].path).toBe("/a.ts")
  })

  test("non-lsp tool does not call recorder", async () => {
    if (typeof __setRecorderForTest !== "function") throw new Error("seam missing")
    const calls: unknown[][] = []
    __setRecorderForTest({ record: (...args: unknown[]) => calls.push(args), close: () => {} } as any)
    const p = await pluginFn({} as never, { compact: true, minified: true })
    const out = { title: "x", output: "keep", metadata: {} }
    await p["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} } as any, out as any)
    expect(calls.length).toBe(0)
    expect(out.output).toBe("keep")
  })

  test("sessionID passed through", async () => {
    if (typeof __setRecorderForTest !== "function") throw new Error("seam missing")
    const calls: unknown[][] = []
    __setRecorderForTest({ record: (...args: unknown[]) => calls.push(args), close: () => {} } as any)
    const p = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const out = { title: "t", output: JSON.stringify(loc, null, 2), metadata: { result: loc } }
    await p["tool.execute.after"]!({ tool: "lsp", sessionID: "my-session-123", callID: "c", args: {} } as any, out as any)
    expect(calls[0]![2]).toBe("my-session-123")
  })

  test("hook does not modify metadata fields", async () => {
    if (typeof __setRecorderForTest !== "function") throw new Error("seam missing")
    __setRecorderForTest({ record: () => {}, close: () => {} } as any)
    const p = await pluginFn({} as never, { compact: true, minified: true })
    const loc = [{ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    const attachments = [{ type: "file", mime: "text/plain", url: "file:///x" }]
    const out = { title: "keep-title", output: JSON.stringify(loc, null, 2), metadata: { result: loc, truncated: true, outputPath: "/tmp/x" }, attachments } as any
    const metaBefore = structuredClone(out.metadata)
    await p["tool.execute.after"]!({ tool: "lsp", sessionID: "s", callID: "c", args: {} } as any, out as any)
    expect(out.title).toBe("keep-title")
    expect(out.attachments).toBe(attachments)
    expect(out.metadata).toEqual(metaBefore)
    expect(out.metadata.result).toBe(loc)
  })
})
