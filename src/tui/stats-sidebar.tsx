/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiSlotPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
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
import { formatTokens, formatCompression, formatHeader } from "./stats-format"
import { deriveCompressionPercent, emptyAggregate, type Aggregate } from "../stats/contract"
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
  const s = useSession && sHasMeasured ? formatCompression(deriveCompressionPercent(useSession)) + " session" : null
  const p = useProject && pHasMeasured ? formatCompression(deriveCompressionPercent(useProject)) + " project" : null
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

export type SidebarTone = "accent" | "success" | "muted" | "warning" | "error"

export type SidebarRow =
  | { kind: "section"; label: string }
  | { kind: "metric"; label: string; value: string; tone: SidebarTone }
  | { kind: "message"; text: string; tone: SidebarTone }

export function colorForTone(theme: TuiThemeCurrent, tone: SidebarTone) {
  if (tone === "accent") return theme.accent
  if (tone === "success") return theme.success
  if (tone === "warning") return theme.warning
  if (tone === "error") return theme.error
  return theme.textMuted
}

export function getExpandedRows(state: {
  status: TuiStatus
  sessionAgg: Aggregate | null
  projectAgg: Aggregate | null
  // for stale, lastGood
  lastSessionAgg?: Aggregate | null
  lastProjectAgg?: Aggregate | null
}): SidebarRow[] {
  if (state.status === "initializing") return [{ kind: "message", text: "Stats initializing", tone: "muted" }]
  if (state.status === "unavailable") return [{ kind: "message", text: "Stats unavailable", tone: "warning" }]
  const isStale = state.status === "stale"
  const sessionAgg = isStale ? (state.lastSessionAgg ?? state.sessionAgg) : state.sessionAgg
  const projectAgg = isStale ? (state.lastProjectAgg ?? state.projectAgg) : state.projectAgg

  const rows: SidebarRow[] = []
  if (isStale) rows.push({ kind: "message", text: "Stats stale", tone: "warning" })

  const appendMetrics = (agg: Aggregate) => {
    rows.push({ kind: "metric", label: "Context tokens saved", value: formatTokens(getSaved(agg)), tone: "accent" })
    rows.push({
      kind: "metric",
      label: "Compaction rate",
      value: formatCompression(deriveCompressionPercent(agg)),
      tone: "success",
    })
    rows.push({
      kind: "metric",
      label: "Measured calls",
      value: String(agg.calls - agg.excludedOversizeCalls - agg.tokenizerErrorCalls),
      tone: "muted",
    })
  }
  const appendDiagnostics = (agg: Aggregate) => {
    if (agg.excludedOversizeCalls > 0) {
      rows.push({ kind: "metric", label: "Oversize exclusions", value: String(agg.excludedOversizeCalls), tone: "warning" })
    }
    if (agg.tokenizerErrorCalls > 0) {
      rows.push({ kind: "metric", label: "Tokenizer errors", value: String(agg.tokenizerErrorCalls), tone: "error" })
    }
  }

  // Session section handling
  // If session empty and project has measured, we still show Session with No measured calls yet
  // but we will render Session anyway for clarity (project rows follow immediately after Session block)
  const sessionMeasured = hasMeasured(sessionAgg)
  const projectMeasured = hasMeasured(projectAgg)

  // Per spec "If Session has no bucket/observations and Project has measurements, Project rows follow immediately."
  // We'll include Session when sessionAgg is not null; when null we skip Session header to let Project follow immediately.
  if (sessionAgg !== null) {
    rows.push({ kind: "section", label: "Session" })
    if (!sessionMeasured) {
      rows.push({ kind: "message", text: "No measured calls yet", tone: "muted" })
    } else {
      appendMetrics(sessionAgg)
    }
    appendDiagnostics(sessionAgg)
  } else {
    // session empty, show placeholder if project not measured? For zero state, show Session placeholder?
    // If we skip Session when null, we still need to indicate empty? Spec says valid never-observed session uses same empty state.
    // For session empty with project data, we skip Session and go directly to Project for compactness.
    // We'll not add Session block when null and projectMeasured.
    if (!projectMeasured) {
      rows.push({ kind: "section", label: "Session" })
      rows.push({ kind: "message", text: "No measured calls yet", tone: "muted" })
    }
  }

  // Project section
  // Project always exists as aggregate (even if empty), but we handle null as empty
  const proj = projectAgg ?? emptyAggregate()
  rows.push({ kind: "section", label: "Project" })
  if (!hasMeasured(proj)) {
    rows.push({ kind: "message", text: "No measured calls yet", tone: "muted" })
  } else {
    appendMetrics(proj)
  }
  appendDiagnostics(proj)
  return rows
}

// ---- Solid component ----

const REFRESH_DEBOUNCE_MS = 200 // kept for spec alignment, used inside poller

export function StatsSidebarContent(props: { api: TuiPluginApi; sessionId: () => string; theme: TuiThemeCurrent }) {
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

  const expandedRows = createMemo(() => {
    const st = s()
    return getExpandedRows({ status: st.status, sessionAgg: st.sessionAgg, projectAgg: st.projectAgg })
  })

  // @ts-ignore
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" onMouseDown={toggleCollapsed}>
        <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme.accent}>
          <text fg={props.theme.background}>
            <b>{isCollapsed() ? "▶ " : "▼ "}{formatHeader()}</b>
          </text>
        </box>
      </box>
      {isCollapsed() ? (
        <box>
          <text fg={collapsedText().includes("%") ? props.theme.success : props.theme.textMuted}>
            <b>{collapsedText()}</b>
          </text>
        </box>
      ) : (
        <box flexDirection="column">
          {expandedRows().map((row: SidebarRow) => (
            row.kind === "section" ? (
              <box width="100%" marginTop={1}>
                <text fg={props.theme.text}><b>{row.label}</b></text>
              </box>
            ) : row.kind === "metric" ? (
              <box width="100%" flexDirection="row" justifyContent="space-between">
                <text fg={props.theme.textMuted}>{row.label}</text>
                <text fg={colorForTone(props.theme, row.tone)}><b>{row.value}</b></text>
              </box>
            ) : (
              <text fg={colorForTone(props.theme, row.tone)}>{row.text}</text>
            )
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
        const theme = createMemo(() => _ctx.theme.current as TuiThemeCurrent)
        return <StatsSidebarContent api={api} sessionId={sessionId} theme={theme()} />
      },
    },
  }
}
