import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = join(root, "src")
const dist = join(root, "dist")
const runtime = new Set([
  "@opentui/core",
  "@opentui/solid",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "solid-js",
  "solid-js/store",
])

type Transform = (
  code: string,
  options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string | null
  },
) => Promise<string>

async function loadTransform(): Promise<Transform> {
  const specifier = "@opentui/solid/scripts/solid-transform.js"
  try {
    const mod = (await import(specifier)) as { transformSolidSource: Transform }
    return mod.transformSolidSource
  } catch {
    const dir = dirname(fileURLToPath(import.meta.resolve("@opentui/solid/package.json")))
    const mod = (await import(pathToFileURL(join(dir, "scripts/solid-transform.js")).href)) as {
      transformSolidSource: Transform
    }
    return mod.transformSolidSource
  }
}

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
    if (!/\.(mjs|js|ts|tsx)$/.test(file) || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue
    seen.add(file)
    const source = existsSync(file) ? readFileSync(file, "utf8") : ""
    for (const spec of relativeImports(source)) {
      const next = resolveImport(file, spec)
      if (next) stack.push(next)
    }
  }
  return [...seen]
}

const transform = await loadTransform()
await rm(dist, { recursive: true, force: true })

const files = walk(join(src, "tui.ts"))
for (const file of files) {
  const rel = relative(src, file)
  if (rel.startsWith("..")) continue
  const out = join(dist, rel)
  await mkdir(dirname(out), { recursive: true })
  const source = await readFile(file, "utf8")
  if (file.endsWith(".tsx")) {
    const compiled = await transform(source, {
      filename: file,
      moduleName: `opentui:runtime-module:${encodeURIComponent("@opentui/solid")}`,
      resolvePath: (specifier) =>
        runtime.has(specifier) ? `opentui:runtime-module:${encodeURIComponent(specifier)}` : null,
    })
    await writeFile(out, compiled)
    continue
  }
  await writeFile(out, source)
}

console.log("build-tui: wrote", files.length, "files under dist/")
