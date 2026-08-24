/**
 * Pure formatters for LSP hook savings statistics sidebar.
 * No state, no I/O. All functions are deterministic.
 */

export function formatTokens(n: number): string {
  if (n === 0) return "0"
  const abs = Math.abs(n)
  const prefix = n < 0 ? "−" : ""
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
  if (pct > 0) return `${fixed}%`
  return `−${fixed}%`
}

export function formatHeader(): string {
  return "LSP compaction (estimate)"
}
