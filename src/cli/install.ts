import { intro, log, note, outro } from "@clack/prompts"
import { configDirForScope, defaultPluginSpec, registerPlugin } from "./config"
import { detectCli } from "./detect"
import type { InstallScopeFlag } from "./flags"
import { resolveInstallScope } from "./scope"

export async function runInstall(options: { scope: InstallScopeFlag }): Promise<number> {
  const cli = detectCli()
  intro(`${cli} install`)
  const scope = await resolveInstallScope(options.scope)
  if (!scope) {
    outro("Install cancelled.")
    return 1
  }
  const result = registerPlugin(defaultPluginSpec(), configDirForScope(scope))
  if (!result.ok) {
    if (!result.server.ok) log.error(result.server.message)
    if (!result.tui.ok) log.error(result.tui.message)
    outro("Install failed.")
    return 1
  }
  log.success(result.server.message)
  log.success(result.tui.message)
  note(`Restart OpenCode so the plugin loads.\nVerify with: \`${cli} doctor\`.`, "Next steps")
  outro("Done.")
  return 0
}
