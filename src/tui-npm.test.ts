import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

function resolveImport(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate
  }
}

function relativeImports(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.\.?\/[^"']+)["']/g)].map((m) => m[1]!)
}

function walk(entry: string): string[] {
  const seen = new Set<string>()
  const stack = [resolve(entry)]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(mjs|js|ts|tsx)$/.test(file)) continue
    const source = readFileSync(file, "utf8")
    for (const spec of relativeImports(source)) {
      const next = resolveImport(file, spec)
      if (next) stack.push(next)
    }
  }
  return [...seen]
}

describe("npm TUI export", () => {
  test("build emits a Solid-compiled sidebar on the ./tui graph", async () => {
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await proc.exited).toBe(0)

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, string>
    }
    const entry = resolve(root, pkg.exports["./tui"])
    const sidebar = walk(entry).find((file) => file.replace(/\\/g, "/").includes("stats-sidebar"))
    expect(sidebar).toBeDefined()
    const text = readFileSync(sidebar!, "utf8")
    expect(text).toContain("opentui:runtime-module:")
    expect(text.includes("_$createElement") || text.includes("_$createComponent") || text.includes("_$insert(")).toBe(
      true,
    )
  })
})
