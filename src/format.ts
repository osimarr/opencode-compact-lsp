import { compactValue } from "./compact"
import type { CompactLspOptions } from "./options"

export type HookOutput = { title: string; output: string; metadata: { result?: unknown } }

export function applyLspOutput(options: CompactLspOptions, hook: HookOutput): string {
  if (!options.compact && !options.minified) return hook.output
  if (hook.output.startsWith("No results found")) return hook.output

  let source: unknown
  if (hook.metadata?.result !== undefined) {
    source = hook.metadata.result
  } else {
    try {
      source = JSON.parse(hook.output)
    } catch {
      return hook.output
    }
  }

  const value = options.compact ? compactValue(source) : source
  return JSON.stringify(value, null, options.minified ? undefined : 2)
}
