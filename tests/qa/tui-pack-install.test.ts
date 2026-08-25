import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const runtimeSpecifiers = [
  "@opentui/core",
  "@opentui/solid",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "solid-js",
  "solid-js/store",
]
const runtimeStub = `
export function createComponent() { return null }
export function effect() {}
export function insertNode() {}
export function insert() {}
export function memo(fn) { return fn }
export function setProp() {}
export function createElement() { return {} }
export function createSignal(v) { return [() => v, () => {}] }
export function createEffect() {}
export function createMemo(fn) { return typeof fn === "function" ? fn : () => fn }
export function on() { return () => {} }
export function onCleanup() {}
export function jsx() { return null }
export function jsxs() { return null }
export function jsxDEV() { return null }
export default {}
`

function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]) => {
      if (code !== 0) {
        throw new Error(`${cmd.join(" ")} exited ${code}\n${stdout}\n${stderr}`)
      }
      return stdout
    },
  )
}

describe("packed TUI export", () => {
  test("package.json ./tui points at the compiled loader", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, string>
    }
    expect(pkg.exports["./tui"]).toBe("./src/entry.mjs")
  })

  test("production pack ships a compiled sidebar and registers a slot", async () => {
    const temp = mkdtempSync(join(tmpdir(), "compact-lsp-tui-pack-"))
    afterAll(() => rmSync(temp, { recursive: true, force: true }))

    await run(["bun", "run", "build"], root)
    const packOut = await run(["bun", "pm", "pack", "--quiet", "--ignore-scripts"], root)
    const tgzName = packOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".tgz"))
      .at(-1)
    expect(tgzName).toBeDefined()
    const tarball = join(root, tgzName!)
    afterAll(() => {
      if (existsSync(tarball)) rmSync(tarball)
    })

    const installRoot = join(temp, "install")
    await run(["mkdir", "-p", installRoot], temp)
    await Bun.write(
      join(installRoot, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "opencode-compact-lsp": `file:${tarball}` },
      }),
    )
    await run(["bun", "install", "--production"], installRoot)

    const pkgRoot = join(installRoot, "node_modules", "opencode-compact-lsp")
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      exports: Record<string, string>
    }
    expect(pkg.exports["./tui"]).toBe("./src/entry.mjs")
    expect(existsSync(join(pkgRoot, "src/entry.mjs"))).toBe(true)
    expect(existsSync(join(pkgRoot, "dist/tui.ts"))).toBe(true)
    expect(existsSync(join(pkgRoot, "dist/tui/stats-sidebar.tsx"))).toBe(true)

    const compiled = readFileSync(join(pkgRoot, "dist/tui/stats-sidebar.tsx"), "utf8")
    expect(compiled).toContain("opentui:runtime-module:")
    expect(compiled.includes("_$createElement") || compiled.includes("_$createComponent") || compiled.includes("_$insert(")).toBe(
      true,
    )
    expect(compiled.includes("from \"solid-js\"") || compiled.includes("from 'solid-js'")).toBe(false)

    const probe = `
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const packageRoot = process.argv[2]
const runtimeSpecifiers = ${JSON.stringify(runtimeSpecifiers)}
const mid = (specifier) => "opentui:runtime-module:" + encodeURIComponent(specifier)
const stub = ${JSON.stringify(runtimeStub)}

Bun.plugin({
  name: "opentui-runtime-module-stubs",
  setup(build) {
    for (const specifier of runtimeSpecifiers) {
      build.module(mid(specifier), () => ({ loader: "js", contents: stub }))
    }
  },
})

const entry = await import(pathToFileURL(join(packageRoot, "src/entry.mjs")).href)
if (typeof entry.default?.tui !== "function") throw new Error("packed ./tui missing tui()")
const calls = []
await entry.default.tui({
  slots: { register: (slot) => calls.push(slot) },
  lifecycle: { onDispose() {} },
})
if (calls.length !== 1) throw new Error("expected slots.register once, got " + calls.length)
if (typeof calls[0]?.slots?.sidebar_content !== "function") {
  throw new Error("registered slot missing sidebar_content")
}
console.log("packed tui registered sidebar")
`
    const probeFile = join(temp, "probe.mjs")
    await Bun.write(probeFile, probe)
    const out = await run(["bun", probeFile, pkgRoot], temp)
    expect(out).toContain("packed tui registered sidebar")
  }, 120_000)
})
