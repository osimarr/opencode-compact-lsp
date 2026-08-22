export type CliDetectInput = {
  userAgent?: string
  argv1?: string
}

const PLUGIN_NAME = "opencode-compact-lsp"

export function detectCli(input: CliDetectInput = {}): string {
  const userAgent = input.userAgent ?? process.env.npm_config_user_agent ?? ""
  const argv1 = input.argv1 ?? process.argv[1] ?? ""
  if (userAgent.startsWith("bun/") || argv1.includes("bunx") || argv1.includes(".bun/")) return `bunx ${PLUGIN_NAME}`
  if (userAgent.includes("npm/") || argv1.includes("npx") || argv1.includes("_npx")) return `npx ${PLUGIN_NAME}`
  return PLUGIN_NAME
}

export function invokedSpecTag(text: string): string | undefined {
  const dist = text.match(/opencode-compact-lsp@(latest|next)\b/)
  if (dist) return dist[1]
  return text.match(/opencode-compact-lsp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/)?.[1]
}

export function pluginSpec(cli: string, version: string, argv1 = ""): string {
  const tag = invokedSpecTag(argv1)
  if (tag) return `${PLUGIN_NAME}@${tag}`
  if (cli.startsWith("npx ") || cli.startsWith("bunx ")) return `${PLUGIN_NAME}@${version}`
  return PLUGIN_NAME
}
