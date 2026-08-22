import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearPluginCaches, ensurePluginEntry } from "./config"

describe("ensurePluginEntry", () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "compact-lsp-config-"))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  test("creates opencode.json with the plugin tuple", () => {
    const result = ensurePluginEntry("opencode-compact-lsp", { compact: true, minified: true }, configDir)
    expect(result.ok).toBe(true)
    expect(result.action).toBe("added")
    expect(result.configPath).toBe(join(configDir, "opencode.json"))
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8"))).toEqual({
      plugin: [["opencode-compact-lsp", { compact: true, minified: true }]],
    })
  })

  test("second call with the same spec and options is already_present", () => {
    ensurePluginEntry("opencode-compact-lsp", { compact: true, minified: true }, configDir)
    const result = ensurePluginEntry("opencode-compact-lsp", { compact: true, minified: true }, configDir)
    expect(result.action).toBe("already_present")
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8")).plugin).toEqual([
      ["opencode-compact-lsp", { compact: true, minified: true }],
    ])
  })

  test("second call with different options updates the tuple", () => {
    ensurePluginEntry("opencode-compact-lsp", { compact: true, minified: true }, configDir)
    const result = ensurePluginEntry("opencode-compact-lsp", { compact: false, minified: true }, configDir)
    expect(result.action).toBe("updated")
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8")).plugin).toEqual([
      ["opencode-compact-lsp", { compact: false, minified: true }],
    ])
  })

  test("converts an existing string entry to a tuple", () => {
    writeFileSync(
      join(configDir, "opencode.json"),
      `${JSON.stringify({ plugin: ["other-plugin", "opencode-compact-lsp"], model: "keep-me" }, null, 2)}\n`,
    )
    const result = ensurePluginEntry("opencode-compact-lsp", { compact: true, minified: true }, configDir)
    expect(result.action).toBe("updated")
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8"))).toEqual({
      plugin: ["other-plugin", ["opencode-compact-lsp", { compact: true, minified: true }]],
      model: "keep-me",
    })
  })
})

describe("clearPluginCaches", () => {
  test("deletes packages/opencode-compact-lsp@latest", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "compact-lsp-cache-"))
    const target = join(cacheDir, "packages", "opencode-compact-lsp@latest")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "keep.txt"), "x")
    mkdirSync(join(cacheDir, "packages", "other@1.0.0"), { recursive: true })
    const result = clearPluginCaches(cacheDir)
    expect(result.cleared).toBe(1)
    expect(result.errors).toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(existsSync(join(cacheDir, "packages", "other@1.0.0"))).toBe(true)
    rmSync(cacheDir, { recursive: true, force: true })
  })
})
