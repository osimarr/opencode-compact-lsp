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

export type FlagTriple = true | false | "conflict" | undefined

export function boolFlag(args: readonly string[], name: string): FlagTriple {
  const yes = args.includes(`--${name}`)
  const no = args.includes(`--no-${name}`)
  if (yes && no) return "conflict"
  if (yes) return true
  if (no) return false
  return undefined
}

export function compactFlag(args: readonly string[]): FlagTriple {
  return boolFlag(args, "compact")
}

export function minifiedFlag(args: readonly string[]): FlagTriple {
  return boolFlag(args, "minified")
}
