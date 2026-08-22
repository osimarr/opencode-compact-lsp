export type CompactLspOptions = { compact: boolean; minified: boolean }

export function resolveOptions(raw?: Record<string, unknown>): CompactLspOptions {
  return {
    compact: raw?.compact === false ? false : true,
    minified: raw?.minified === false ? false : true,
  }
}
