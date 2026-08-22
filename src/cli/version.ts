import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_NAME = "opencode-compact-lsp"

export function runningPackageVersion(start = fileURLToPath(import.meta.url)): string {
  let dir = dirname(start)
  while (true) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown; version?: unknown }
        if (parsed.name === PACKAGE_NAME && typeof parsed.version === "string") return parsed.version
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return "latest"
    dir = parent
  }
}

export function opencodeVersionOk(raw: string): boolean {
  return Boolean(raw.match(/(\d+)\.(\d+)\.(\d+)/))
}
