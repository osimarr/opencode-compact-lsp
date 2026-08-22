import { isCancel, log, select } from "@clack/prompts"
import type { InstallScope, InstallScopeFlag } from "./flags"

export async function resolveInstallScope(flag: InstallScopeFlag): Promise<InstallScope | undefined> {
  if (flag === "conflict") {
    log.error("Use either --global or --project, not both.")
    return undefined
  }
  if (flag === "global" || flag === "project") return flag
  if (process.env.CI === "true") {
    log.error("Pass --global or --project (required in CI).")
    return undefined
  }
  const choice = await select({
    message: "Install where?",
    options: [
      { value: "global", label: "Global", hint: "~/.config/opencode" },
      { value: "project", label: "Project", hint: ".opencode/opencode.json" },
    ],
  })
  if (isCancel(choice)) return undefined
  return choice
}
