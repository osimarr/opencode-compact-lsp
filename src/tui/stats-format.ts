/**
 * Pure formatters for LSP hook savings statistics sidebar.
 * No state, no I/O. All functions are deterministic.
 */

export function formatTokens(n: number): string {
  if (n === 0) return "0"
  const abs = Math.abs(n)
  // Unicode: ≈ U+2248, − U+2212
  const prefix = n < 0 ? "−≈" : "≈"
  let magnitude: string
  if (abs < 1000) {
    magnitude = String(Math.round(abs))
  } else if (abs < 1_000_000) {
    magnitude = (abs / 1000).toFixed(1) + "K"
  } else {
    magnitude = (abs / 1_000_000).toFixed(1) + "M"
  }
  return prefix + magnitude
}

export function formatCompression(pct: number | null): string {
  if (pct === null || pct === undefined) return "—"
  if (!Number.isFinite(pct)) return "—"
  if (pct === 0) return "0.0%"
  const abs = Math.abs(pct)
  const fixed = abs.toFixed(1)
  if (pct > 0) return `≈${fixed}%`
  return `−≈${fixed}%`
}

export function formatHeader(): string {
  return "LSP hook savings (estimate)"
}

export function formatFooter(): string {
  return "o200k_base estimate \u00b7 output context"
}

/**
 * Collapsed line helpers – pure, no state.
 * These are derivatives of formatTokens used by the sidebar collapsed view.
 */

export function formatCollapsed(
  session: { saved: number; hasMeasured: boolean } | null,
  project: { saved: number; hasMeasured: boolean } | null,
): string {
  // Returns the suffix after "LSP " for ready states, or the full special label.
  // Caller prefixes with "LSP " and handles initializing/unavailable/stale wrappers.
  const s = session && session.hasMeasured ? formatTokens(session.saved) + " session" : null
  const p = project && project.hasMeasured ? formatTokens(project.saved) + " project" : null
  if (s && p) return `${s} / ${p}`
  if (s) return s
  if (p) return p
  return "no data"
}

export function formatCollapsedWithStatus(
  status: "ready" | "initializing" | "unavailable" | "stale",
  session: { saved: number; hasMeasured: boolean } | null,
  project: { saved: number; hasMeasured: boolean } | null,
): string {
  if (status === "initializing") return "LSP stats initializing"
  if (status === "unavailable") return "LSP stats unavailable"
  const body = formatCollapsed(session, project)
  // Stale and ready share the same body structure but stale prefixes.
  // For "no data" / diagnostics handling see sidebar component – formatters stay pure.
  if (status === "stale") {
    // If body is "no data", stale still shows stale marker with last-good values when available.
    // When body is "no data" and no last-good, caller should show unavailable instead.
    return `LSP stats stale \u00b7 ${body}`
  }
  // ready
  // Distinguish measured zero vs no data: formatTokens(0) is "0", so zero is shown as "0 session"
  // Caller decides "no measured data" vs "no data" based on observed diagnostics.
  return `LSP ${body}`
}
