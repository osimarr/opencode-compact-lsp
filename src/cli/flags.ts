export function skipClearConfirm(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  return args.includes("--yes") || env.CI === "true"
}

export type InstallScope = "global" | "project"
export type InstallScopeFlag = InstallScope | "conflict" | undefined

export function installScope(args: readonly string[]): InstallScopeFlag {
  const global = args.includes("--global")
  const project = args.includes("--project")
  if (global && project) return "conflict"
  if (global) return "global"
  if (project) return "project"
  return undefined
}
