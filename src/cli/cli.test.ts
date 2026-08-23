import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version as string

function plugins(dir: string): unknown[] {
  return JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8")).plugin
}

function tuiPlugins(dir: string): unknown[] {
  return JSON.parse(readFileSync(join(dir, "tui.json"), "utf-8")).plugin
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

  test("install --global writes spec string into opencode.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(0)
    expect(plugins(dir)).toEqual(["opencode-compact-lsp"])
    expect(tuiPlugins(dir)).toEqual(["opencode-compact-lsp"])
  })

  test("install --project writes .opencode/opencode.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "compact-lsp-proj-"))
    dirs.push(cwd)
    const result = await runCli(["install", "--project"], { OPENCODE_CONFIG_DIR: "", npm_config_user_agent: "" }, cwd)
    expect(result.code).toBe(0)
    expect(plugins(join(cwd, ".opencode"))).toEqual(["opencode-compact-lsp"])
  })

  test("doctor --fix --global is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const env = { OPENCODE_CONFIG_DIR: dir, npm_config_user_agent: "" }
    expect((await runCli(["doctor", "--fix", "--global"], env)).code).toBe(0)
    expect((await runCli(["doctor", "--fix", "--global"], env)).code).toBe(0)
    expect(plugins(dir)).toEqual(["opencode-compact-lsp"])
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

  test("npx user agent pins version in spec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "npm/10.9.2 node/v22.0.0",
    })
    expect(result.code).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain("npx opencode-compact-lsp")
    expect(plugins(dir)).toEqual([`opencode-compact-lsp@${version}`])
  })

  test("--version prints package version", async () => {
    const result = await runCli(["--version"], {})
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(version)
  })

  test("--help exits 0 and lists version and install", async () => {
    const result = await runCli(["--help"], {})
    expect(result.code).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(version)
    expect(`${result.stdout}${result.stderr}`).toContain("install")
  })

  test("bunx user agent pins version and shows bunx intro", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "bun/1.2.0",
    })
    expect(result.code).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain("bunx opencode-compact-lsp")
    expect(plugins(dir)).toEqual([`opencode-compact-lsp@${version}`])
  })

  test("empty user agent shows unpinned install intro without npx", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain("opencode-compact-lsp install")
    expect(`${result.stdout}${result.stderr}`).not.toContain("npx ")
    expect(plugins(dir)).toEqual(["opencode-compact-lsp"])
  })

  test("doctor --global on empty config dir reports not set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["doctor", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain("not set")
    expect(`${result.stdout}${result.stderr}`).toContain("install")
  })

  test("doctor --global reports parse error on garbage opencode.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    writeFileSync(join(dir, "opencode.json"), "{ not json")
    const result = await runCli(["doctor", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain("parse error")
  })

  test("doctor reports missing opencode.json when the plugin is only in tui.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    writeFileSync(join(dir, "tui.json"), `${JSON.stringify({ plugin: ["opencode-compact-lsp"] }, null, 2)}\n`)
    const result = await runCli(["doctor", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain("opencode.json plugin: no")
    expect(`${result.stdout}${result.stderr}`).toContain("tui.json plugin: yes")
  })

  test("install --global writes tui.json string spec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compact-lsp-cli-"))
    dirs.push(dir)
    const result = await runCli(["install", "--global"], {
      OPENCODE_CONFIG_DIR: dir,
      npm_config_user_agent: "",
    })
    expect(result.code).toBe(0)
    expect(existsSync(join(dir, "opencode.json"))).toBe(true)
    expect(existsSync(join(dir, "tui.json"))).toBe(true)
    expect(tuiPlugins(dir)).toEqual(["opencode-compact-lsp"])
  })

  test("doctor --project after install --project sees the project plugin", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "compact-lsp-proj-"))
    const trap = mkdtempSync(join(tmpdir(), "compact-lsp-trap-"))
    dirs.push(cwd, trap)
    const env = { OPENCODE_CONFIG_DIR: trap, npm_config_user_agent: "" }
    expect((await runCli(["install", "--project"], env, cwd)).code).toBe(0)
    const result = await runCli(["doctor", "--project"], env, cwd)
    expect(`${result.stdout}${result.stderr}`).toContain("opencode.json plugin: yes")
    expect(`${result.stdout}${result.stderr}`).toContain("tui.json plugin: yes")
    expect(`${result.stdout}${result.stderr}`).toContain(join(cwd, ".opencode", "opencode.json"))
    expect(existsSync(join(cwd, ".opencode", "tui.json"))).toBe(true)
    expect(existsSync(join(trap, "opencode.json"))).toBe(false)
  })
})
