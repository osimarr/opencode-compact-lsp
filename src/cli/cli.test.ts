import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version as string

function plugins(dir: string): unknown[] {
  return JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8")).plugin
}

async function runCli(args: string[], env: Record<string, string>, cwd = root) {
  const proc = Bun.spawn(["bun", join(root, "src/cli.ts"), ...args], {
    cwd,
    env: { ...process.env, CI: "true", ...env },
    stderr: "pipe",
    stdout: "pipe",
  })
  const code = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code, stdout, stderr }
}

describe("cli", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  test("install --global writes tuple into opencode.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(0)
    expect(plugins(dir)).toEqual([["opencode-compact-lsp", { compact: true, minified: true }]])
  })

  test("install --no-compact --minified persists flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global", "--no-compact", "--minified"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(0)
    expect(plugins(dir)[0]).toEqual(["opencode-compact-lsp", { compact: false, minified: true }])
  })

  test("install --project writes .opencode/opencode.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "compact-lsp-proj-"))
    dirs.push(cwd)
    const result = await runCli(["install", "--project"], { OPENCODE_CONFIG_DIR: "", npm_config_user_agent: "" }, cwd)
    expect(result.code).toBe(0)
    expect(plugins(join(cwd, ".opencode"))).toEqual([
      ["opencode-compact-lsp", { compact: true, minified: true }],
    ])
  })

  test("doctor --fix --global is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const env = { OPENCODE_CONFIG_DIR: dir, npm_config_user_agent: "" }
    expect((await runCli(["doctor", "--fix", "--global"], env)).code).toBe(0)
    expect((await runCli(["doctor", "--fix", "--global"], env)).code).toBe(0)
    expect(plugins(dir)).toEqual([["opencode-compact-lsp", { compact: true, minified: true }]])
  })

  test("doctor --clear --yes removes plugin cache", async () => {
    const cache = mkdtempSync(join(tmpdir(), "compact-lsp-cache-"))
    dirs.push(cache)
    const pkg = join(cache, "packages", "opencode-compact-lsp@latest")
    await Bun.write(join(pkg, "keep.txt"), "x")
    const result = await runCli(["doctor", "--clear", "--yes"], { OPENCODE_CACHE_DIR: cache })
    expect(result.code).toBe(0)
    expect(await Bun.file(join(pkg, "keep.txt")).exists()).toBe(false)
  })

  test("--compact and --no-compact exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global", "--compact", "--no-compact"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain("--compact")
    expect(existsSync(join(dir, "opencode.json"))).toBe(false)
  })

  test("npx user agent pins version in spec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "npm/10.9.2 node/v22.0.0",
    })
    expect(result.code).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain("npx opencode-compact-lsp")
    expect(plugins(dir)).toEqual([[`opencode-compact-lsp@${version}`, { compact: true, minified: true }]])
  })

  test("--version prints package version", async () => {
    const result = await runCli(["--version"], {})
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(version)
  })
})
