export function pluginId(url: string): string {
  const path = url.replace(/\\/g, "/")
  if (path.includes("/node_modules/") || path.includes("/dist/")) return "opencode-compact-lsp"
  return "opencode-compact-lsp-dev"
}
