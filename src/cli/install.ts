import { intro, log, note, outro } from "@clack/prompts"
import { resolveOptions } from "../options"
import { configDirForScope, defaultPluginSpec, ensurePluginEntry } from "./config"
import { detectCli } from "./detect"
import type { FlagTriple, InstallScopeFlag } from "./flags"
import { resolveInstallScope } from "./scope"

export function flagConflictMessage(compact: FlagTriple, minified: FlagTriple): string | undefined {
  if (compact === "conflict") return "Use either --compact or --no-compact, not both."
  if (minified === "conflict") return "Use either --minified or --no-minified, not both."
  return undefined
}

export async function runInstall(options: {
  scope: InstallScopeFlag
  compact: FlagTriple
  minified: FlagTriple
}): Promise<number> {
  const cli = detectCli()
  intro(`${cli} install`)
  const conflict = flagConflictMessage(options.compact, options.minified)
  if (conflict) {
    log.error(conflict)
    outro("Install failed.")
    return 1
  }
  const scope = await resolveInstallScope(options.scope)
  if (!scope) {
    outro("Install cancelled.")
    return 1
  }
  const pluginOptions = resolveOptions({ compact: options.compact, minified: options.minified })
  const result = ensurePluginEntry(defaultPluginSpec(), pluginOptions, configDirForScope(scope))
  if (!result.ok) {
    log.error(result.message)
    outro("Install failed.")
    return 1
  }
  log.success(result.message)
  note(`Restart OpenCode so the plugin loads.\nVerify with: \`${cli} doctor\`.`, "Next steps")
  outro("Done.")
  return 0
}
