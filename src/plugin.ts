import type { Plugin } from "@opencode-ai/plugin"
import { resolveOptions } from "./options"
import { applyLspOutput } from "./format"

export default (async (_input, raw) => {
  const options = resolveOptions(raw)
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "lsp") return
      output.output = applyLspOutput(options, output)
    },
  }
}) satisfies Plugin
