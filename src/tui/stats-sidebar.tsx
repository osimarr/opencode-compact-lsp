/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
// eslint-disable-next-line @typescript-eslint/ban-ts-comment - solid-js stub has no types in CI
// @ts-ignore: solid-js types are provided by runtime, ignore missing declaration for test stub
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"

// Targeted JSX fix for @opentui/solid without file-wide nocheck
declare global {
  namespace JSX {
    interface IntrinsicElements {
      box: any
      text: any
      b: any
    }
  }
}
import { formatTokens, formatCompression, formatHeader, formatFooter } from "./stats-format"
import { deriveSaved, deriveCompressionPercent, emptyAggregate, type Aggregate } from "../stats/contract"
import { createTuiPoller, readTuiState, clearReaderState, type TuiReadResult, type TuiStatus } from "./stats-reader"

// ---- pure helpers for tests and component ----

function hasMeasured(agg: Aggregate | null): boolean {
  if (!agg) return false
  const measured = agg.calls - agg.excludedOversizeCalls - agg.tokenizerErrorCalls
  return measured > 0
}
function hasDiagnostics(agg: Aggregate | null): boolean {
  if (!agg) return false
  return agg.calls > 0 || agg.excludedOversizeCalls > 0 || agg.tokenizerErrorCalls > 0
}
function getSaved(agg: Aggregate | null): number {
  if (!agg) return 0
  return agg.beforeTokens - agg.afterTokens
}

export function getCollapsedText(state: {
  status: TuiStatus
  sessionAgg: Aggregate | null
  projectAgg: Aggregate | null
  // for stale, optionally provide lastGood aggregates
  lastSessionAgg?: Aggregate | null
  lastProjectAgg?: Aggregate | null
}): string {
  if (state.status === "initializing") return "LSP stats initializing"
  if (state.status === "unavailable") return "LSP stats unavailable"
  const useSession = state.status === "stale" ? (state.lastSessionAgg ?? state.sessionAgg) : state.sessionAgg
  const useProject = state.status === "stale" ? (state.lastProjectAgg ?? state.projectAgg) : state.projectAgg

  const sHasMeasured = hasMeasured(useSession)
  const pHasMeasured = hasMeasured(useProject)
  // build body
  const s = useSession && sHasMeasured ? formatTokens(getSaved(useSession)) + " session" : null
  const p = useProject && pHasMeasured ? formatTokens(getSaved(useProject)) + " project" : null
  let body: string
  if (s && p) body = `${s} / ${p}`
  else if (s) body = s
  else if (p) body = p
  else {
    const sDiag = hasDiagnostics(useSession)
    const pDiag = hasDiagnostics(useProject)
    if (sDiag || pDiag) body = "no measured data"
    else body = "no data"
  }

  if (state.status === "stale") {
    return `LSP stats stale \u00b7 ${body}`
  }
  // ready or zero
  return `LSP ${body}`
}

export function getExpandedLines(state: {
  status: TuiStatus
  sessionAgg: Aggregate | null
  projectAgg: Aggregate | null
  // for stale, lastGood
  lastSessionAgg?: Aggregate | null
  lastProjectAgg?: Aggregate | null
}): string[] {
  if (state.status === "initializing") return ["Stats initializing"]
  if (state.status === "unavailable") return ["Stats unavailable"]
  const isStale = state.status === "stale"
  const sessionAgg = isStale ? (state.lastSessionAgg ?? state.sessionAgg) : state.sessionAgg
  const projectAgg = isStale ? (state.lastProjectAgg ?? state.projectAgg) : state.projectAgg

  const lines: string[] = []
  if (isStale) lines.push("Stats stale")
  lines.push(formatHeader())
  lines.push("")

  // Session section handling
  // If session empty and project has measured, we still show Session with No measured calls yet
  // but we will render Session anyway for clarity (project rows follow immediately after Session block)
  const sessionHasBucket = sessionAgg !== null
  const sessionMeasured = hasMeasured(sessionAgg)
  const projectMeasured = hasMeasured(projectAgg)

  // Per spec "If Session has no bucket/observations and Project has measurements, Project rows follow immediately."
  // We'll include Session when sessionAgg is not null; when null we skip Session header to let Project follow immediately.
  if (sessionAgg !== null) {
    lines.push("Session")
    if (!sessionMeasured) {
      lines.push("  No measured calls yet")
      if (sessionAgg.excludedOversizeCalls > 0) lines.push(`  Oversize exclusions       ${sessionAgg.excludedOversizeCalls}`)
      if (sessionAgg.tokenizerErrorCalls > 0) lines.push(`  Tokenizer errors          ${sessionAgg.tokenizerErrorCalls}`)
      lines.push(`  Truncated                 ${sessionAgg.truncatedCalls}`)
    } else {
      lines.push(`  Est. context-token delta  ${formatTokens(getSaved(sessionAgg))}`)
      lines.push(`  Savings rate              ${formatCompression(deriveCompressionPercent(sessionAgg))}`)
      lines.push(`  Measured calls            ${sessionAgg.calls - sessionAgg.excludedOversizeCalls - sessionAgg.tokenizerErrorCalls}`)
      lines.push(`  Truncated                 ${sessionAgg.truncatedCalls}`)
      if (sessionAgg.excludedOversizeCalls > 0) lines.push(`  Oversize exclusions       ${sessionAgg.excludedOversizeCalls}`)
      if (sessionAgg.tokenizerErrorCalls > 0) lines.push(`  Tokenizer errors          ${sessionAgg.tokenizerErrorCalls}`)
    }
    lines.push("")
  } else {
    // session empty, show placeholder if project not measured? For zero state, show Session placeholder?
    // If we skip Session when null, we still need to indicate empty? Spec says valid never-observed session uses same empty state.
    // For session empty with project data, we skip Session and go directly to Project for compactness.
    // We'll not add Session block when null and projectMeasured.
    if (!projectMeasured) {
      lines.push("Session")
      lines.push("  No measured calls yet")
      lines.push("")
    }
  }

  // Project section
  // Project always exists as aggregate (even if empty), but we handle null as empty
  const proj = projectAgg ?? emptyAggregate()
  lines.push("Project")
  if (!hasMeasured(proj)) {
    lines.push("  No measured calls yet")
    if (proj.excludedOversizeCalls > 0) lines.push(`  Oversize exclusions       ${proj.excludedOversizeCalls}`)
    if (proj.tokenizerErrorCalls > 0) lines.push(`  Tokenizer errors          ${proj.tokenizerErrorCalls}`)
    // Project omits Truncated per spec
  } else {
    lines.push(`  Est. context-token delta  ${formatTokens(getSaved(proj))}`)
    lines.push(`  Savings rate              ${formatCompression(deriveCompressionPercent(proj))}`)
    lines.push(`  Measured calls            ${proj.calls - proj.excludedOversizeCalls - proj.tokenizerErrorCalls}`)
    if (proj.excludedOversizeCalls > 0) lines.push(`  Oversize exclusions       ${proj.excludedOversizeCalls}`)
    if (proj.tokenizerErrorCalls > 0) lines.push(`  Tokenizer errors          ${proj.tokenizerErrorCalls}`)
  }
  lines.push("")
  lines.push(formatFooter())
  return lines
}

// ---- Solid component ----

const REFRESH_DEBOUNCE_MS = 200 // kept for spec alignment, used inside poller

export function StatsSidebarContent(props: { api: TuiPluginApi; sessionId: () => string }) {
  const initialCollapsed = (() => {
    try {
      return props.api.kv.get<boolean>("collapsed", false) ?? false
    } catch {
      return false
    }
  })()
  const [collapsed, setCollapsed] = createSignal<boolean>(initialCollapsed)

  const [state, setState] = createSignal<TuiReadResult>({
    status: "initializing",
    snapshot: null,
    revision: null,
    projectAgg: null,
    sessionAgg: null,
  })

  let pollDispose: (() => void) | null = null
  let generation = 0

  const directory = () => {
    try {
      return (props.api.state.path.directory as string) ?? ""
    } catch {
      return ""
    }
  }

  const setup = () => {
    const sid = props.sessionId()
    const dir = directory()
    if (!sid || !dir) {
      generation++
      if (pollDispose) {
        pollDispose()
        pollDispose = null
      }
      setState({ status: "unavailable", snapshot: null, revision: null, projectAgg: null, sessionAgg: null })
      return
    }
    // close old watcher, clear poll and debounce timers, invalidate inflight reads
    if (pollDispose) {
      pollDispose()
      pollDispose = null
    }
    const myGen = ++generation
    // establish new resources and perform immediate read
    pollDispose = createTuiPoller({
      directory: dir,
      sessionId: sid,
      env: process.env as unknown as NodeJS.ProcessEnv,
      onUpdate: (result) => {
        if (myGen !== generation) return
        setState(result)
        try {
          props.api.renderer.requestRender()
        } catch {}
      },
    })
  }

  createEffect(
    on(
      () => props.sessionId(),
      () => {
        setup()
      },
    ),
  )
  createEffect(
    on(
      () => directory(),
      () => {
        setup()
      },
    ),
  )

  onCleanup(() => {
    generation++
    if (pollDispose) {
      pollDispose()
      pollDispose = null
    }
  })

  const s = () => state()
  const isCollapsed = () => collapsed()

  const toggleCollapsed = () => {
    const next = !isCollapsed()
    setCollapsed(next as any)
    try {
      // namespaced KV only
      props.api.kv.set("collapsed", next)
    } catch {}
  }

  const collapsedText = createMemo(() => {
    const st = s()
    if (st.status === "stale") {
      // stale uses lastGood aggregates if available; our poller already provides them as projectAgg/sessionAgg for stale status via lastGood storage
      // For collapsed stale, we need to show lastGood body, but our state already contains lastGood's aggregates as current for stale? In reader, stale returns lastGood aggregates.
      return getCollapsedText({ status: st.status, sessionAgg: st.sessionAgg, projectAgg: st.projectAgg })
    }
    return getCollapsedText({ status: st.status, sessionAgg: st.sessionAgg, projectAgg: st.projectAgg })
  })

  const expandedLines = createMemo(() => {
    const st = s()
    return getExpandedLines({ status: st.status, sessionAgg: st.sessionAgg, projectAgg: st.projectAgg })
  })

  // @ts-ignore
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" justifyContent="space-between" onMouseDown={toggleCollapsed}>
        <text>
          <b>{formatHeader()}</b>
        </text>
        <text>{isCollapsed() ? "▶" : "▼"}</text>
      </box>
      {isCollapsed() ? (
        <box>
          <text>{collapsedText()}</text>
        </box>
      ) : (
        <box flexDirection="column">
          {expandedLines().map((line: string) => (
            <text>{line}</text>
          ))}
        </box>
      )}
    </box>
  )
}

export async function createStatsSidebarSlot(api: TuiPluginApi): Promise<TuiSlotPlugin> {
  return {
    order: 260,
    slots: {
      sidebar_content: (_ctx: any, value: any) => {
        const sessionId = () => (value?.session_id as string) ?? ""
        return <StatsSidebarContent api={api} sessionId={sessionId} />
      },
    },
  }
}
