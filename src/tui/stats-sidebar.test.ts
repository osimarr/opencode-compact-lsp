// @ts-nocheck
import { afterAll, describe, expect, mock, test } from "bun:test"

afterAll(() => {
  mock.restore()
})

mock.module("solid-js", () => ({
  createEffect: () => undefined,
  createMemo: (fn: () => unknown) => fn,
  createSignal: (initial: unknown) => [() => initial, () => undefined],
  on: (_source: unknown, fn: unknown) => fn,
  onCleanup: () => undefined,
}))
mock.module("@opentui/solid/jsx-runtime", () => ({
  jsx: () => null,
  jsxs: () => null,
  Fragment: (props: { children?: unknown }) => props.children,
}))
mock.module("@opentui/solid/jsx-dev-runtime", () => ({
  jsxDEV: () => null,
  Fragment: (props: { children?: unknown }) => props.children,
}))
mock.module("@opentui/solid", () => ({
  jsx: () => null,
}))

const { getCollapsedText, getExpandedRows, colorForTone } = await import("./stats-sidebar")

describe("stats-sidebar", () => {
  test("semantic tones resolve to their theme colors", () => {
    const theme = {
      accent: "accent",
      success: "success",
      warning: "warning",
      error: "error",
      textMuted: "muted",
    }

    expect(colorForTone(theme, "accent")).toBe("accent")
    expect(colorForTone(theme, "success")).toBe("success")
    expect(colorForTone(theme, "warning")).toBe("warning")
    expect(colorForTone(theme, "error")).toBe("error")
    expect(colorForTone(theme, "muted")).toBe("muted")
  })

  test("collapsed unavailable shows LSP stats unavailable", () => {
    const text = getCollapsedText({
      status: "unavailable",
      sessionAgg: null,
      projectAgg: null,
    })
    expect(text).toBe("LSP stats unavailable")
  })

  test("expanded session empty with project data", () => {
    const project = {
      calls: 5,
      beforeTokens: 10000,
      afterTokens: 4000,
      truncatedCalls: 0,
      passThroughCalls: 0,
      excludedOversizeCalls: 0,
      tokenizerErrorCalls: 0,
      lastSeenAtMs: 1000,
    } as any
    const rows = getExpandedRows({
      status: "ready",
      sessionAgg: null,
      projectAgg: project,
    })
    expect(rows).toEqual([
      { kind: "section", label: "Project" },
      { kind: "metric", label: "Context tokens saved", value: "6.0K", tone: "accent" },
      { kind: "metric", label: "Compaction rate", value: "60.0%", tone: "success" },
      { kind: "metric", label: "Measured calls", value: "5", tone: "muted" },
    ])
  })

  test("collapsed initializing", () => {
    expect(
      getCollapsedText({ status: "initializing", sessionAgg: null, projectAgg: null }),
    ).toBe("LSP stats initializing")
  })

  test("collapsed session empty project data shows project only", () => {
    const project = {
      calls: 2,
      beforeTokens: 5000,
      afterTokens: 1000,
      truncatedCalls: 0,
      passThroughCalls: 0,
      excludedOversizeCalls: 0,
      tokenizerErrorCalls: 0,
      lastSeenAtMs: 1,
    } as any
    const text = getCollapsedText({ status: "ready", sessionAgg: null, projectAgg: project })
    expect(text).toBe("LSP 80.0% project")
  })

  test("collapsed both empty shows no data", () => {
    expect(getCollapsedText({ status: "ready", sessionAgg: null, projectAgg: null })).toBe("LSP no data")
  })

  test("collapsed diagnostics no measurement shows no measured data", () => {
    const session = {
      calls: 1,
      beforeTokens: 0,
      afterTokens: 0,
      truncatedCalls: 0,
      passThroughCalls: 0,
      excludedOversizeCalls: 1,
      tokenizerErrorCalls: 0,
      lastSeenAtMs: 1,
    } as any
    const text = getCollapsedText({ status: "ready", sessionAgg: session, projectAgg: null })
    expect(text).toBe("LSP no measured data")
  })

  test("collapsed stale shows stale prefix with lastGood", () => {
    const project = {
      calls: 1,
      beforeTokens: 1000,
      afterTokens: 200,
      truncatedCalls: 0,
      passThroughCalls: 0,
      excludedOversizeCalls: 0,
      tokenizerErrorCalls: 0,
      lastSeenAtMs: 1,
    } as any
    const text = getCollapsedText({ status: "stale", sessionAgg: null, projectAgg: null, lastProjectAgg: project } as any)
    expect(text).toContain("LSP stats stale")
    expect(text).toContain("80.0% project")
  })

  test("expanded ready shows session and project deltas", () => {
    const session = {
      calls: 3,
      beforeTokens: 3000,
      afterTokens: 1000,
      truncatedCalls: 1,
      passThroughCalls: 0,
      excludedOversizeCalls: 0,
      tokenizerErrorCalls: 0,
      lastSeenAtMs: 1,
    } as any
    const project = {
      calls: 10,
      beforeTokens: 10000,
      afterTokens: 3000,
      truncatedCalls: 2,
      passThroughCalls: 0,
      excludedOversizeCalls: 1,
      tokenizerErrorCalls: 0,
      lastSeenAtMs: 1,
    } as any
    const rows = getExpandedRows({ status: "ready", sessionAgg: session, projectAgg: project })
    expect(rows).toContainEqual({ kind: "section", label: "Session" })
    expect(rows).toContainEqual({
      kind: "metric",
      label: "Context tokens saved",
      value: "2.0K",
      tone: "accent",
    })
    expect(rows).toContainEqual({
      kind: "metric",
      label: "Compaction rate",
      value: "66.7%",
      tone: "success",
    })
    expect(rows).toContainEqual({ kind: "section", label: "Project" })
    expect(rows).toContainEqual({
      kind: "metric",
      label: "Oversize exclusions",
      value: "1",
      tone: "warning",
    })
    expect(rows).not.toContainEqual(expect.objectContaining({ label: "Truncated" }))
  })

  test("expanded unmeasured session shows diagnostics without Truncated", () => {
    const session = {
      calls: 2,
      beforeTokens: 0,
      afterTokens: 0,
      truncatedCalls: 3,
      passThroughCalls: 0,
      excludedOversizeCalls: 1,
      tokenizerErrorCalls: 1,
      lastSeenAtMs: 1,
    } as any
    const rows = getExpandedRows({ status: "ready", sessionAgg: session, projectAgg: null })
    expect(rows).toContainEqual({ kind: "message", text: "No measured calls yet", tone: "muted" })
    expect(rows).toContainEqual({
      kind: "metric",
      label: "Oversize exclusions",
      value: "1",
      tone: "warning",
    })
    expect(rows).toContainEqual({
      kind: "metric",
      label: "Tokenizer errors",
      value: "1",
      tone: "error",
    })
    expect(rows).not.toContainEqual(expect.objectContaining({ label: "Truncated" }))
  })

  test("expanded initializing shows Stats initializing", () => {
    const rows = getExpandedRows({ status: "initializing", sessionAgg: null, projectAgg: null })
    expect(rows).toEqual([{ kind: "message", text: "Stats initializing", tone: "muted" }])
  })

  test("expanded unavailable shows Stats unavailable", () => {
    const rows = getExpandedRows({ status: "unavailable", sessionAgg: null, projectAgg: null })
    expect(rows).toEqual([{ kind: "message", text: "Stats unavailable", tone: "warning" }])
  })

  test("expanded zero shows zero handling", () => {
    const project = {
      calls: 0,
      beforeTokens: 0,
      afterTokens: 0,
      truncatedCalls: 0,
      passThroughCalls: 0,
      excludedOversizeCalls: 0,
      tokenizerErrorCalls: 0,
      lastSeenAtMs: 0,
    } as any
    const rows = getExpandedRows({ status: "zero", sessionAgg: null, projectAgg: project })
    expect(rows).toEqual([
      { kind: "section", label: "Session" },
      { kind: "message", text: "No measured calls yet", tone: "muted" },
      { kind: "section", label: "Project" },
      { kind: "message", text: "No measured calls yet", tone: "muted" },
    ])
  })
})
