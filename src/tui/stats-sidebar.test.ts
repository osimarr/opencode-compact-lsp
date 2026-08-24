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

const { getCollapsedText, getExpandedLines } = await import("./stats-sidebar")

describe("stats-sidebar", () => {
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
    const lines = getExpandedLines({
      status: "ready",
      sessionAgg: null,
      projectAgg: project,
    })
    const joined = lines.join("\n")
    expect(joined).toContain("LSP hook savings (estimate)")
    expect(joined).toContain("Project")
    expect(joined).toContain("o200k_base estimate")
    expect(joined).toContain("Est. context-token delta")
    expect(joined).toContain("≈6.0K")
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
    expect(text).toBe("LSP " + "≈4.0K project")
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
    // stale uses last aggregates; formatTokens(800)=≈800
    expect(text).toContain("LSP stats stale")
    expect(text).toContain("≈800 project")
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
    const lines = getExpandedLines({ status: "ready", sessionAgg: session, projectAgg: project })
    const joined = lines.join("\n")
    expect(joined).toContain("Session")
    expect(joined).toContain("Project")
    expect(joined).toContain("Est. context-token delta")
    expect(joined).toContain("Savings rate")
    expect(joined).toContain("Measured calls")
    expect(joined).toContain("Truncated")
  })

  test("expanded initializing shows Stats initializing", () => {
    const lines = getExpandedLines({ status: "initializing", sessionAgg: null, projectAgg: null })
    expect(lines).toEqual(["Stats initializing"])
  })

  test("expanded unavailable shows Stats unavailable", () => {
    const lines = getExpandedLines({ status: "unavailable", sessionAgg: null, projectAgg: null })
    expect(lines).toEqual(["Stats unavailable"])
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
    const lines = getExpandedLines({ status: "zero", sessionAgg: null, projectAgg: project })
    const joined = lines.join("\n")
    expect(joined).toContain("LSP hook savings (estimate)")
    expect(joined).toContain("Project")
    expect(joined).toContain("No measured calls yet")
  })
})
