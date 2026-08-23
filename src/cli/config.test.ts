import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  clearPluginCaches,
  configDirForScope,
  ensurePluginEntry,
  ensureTuiPluginEntry,
  matchesPluginEntry,
  pluginCacheDirs,
} from "./config"

const pluginTs = join(dirname(fileURLToPath(import.meta.url)), "../plugin.ts")

describe("ensurePluginEntry", () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "compact-lsp-config-"))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  test("creates opencode.json with the plugin spec string", () => {
    const result = ensurePluginEntry("opencode-compact-lsp", configDir)
    expect(result.ok).toBe(true)
    expect(result.action).toBe("added")
    expect(result.configPath).toBe(join(configDir, "opencode.json"))
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8"))).toEqual({
      plugin: ["opencode-compact-lsp"],
    })
  })

  test("second call with the same spec is already_present", () => {
    ensurePluginEntry("opencode-compact-lsp", configDir)
    const result = ensurePluginEntry("opencode-compact-lsp", configDir)
    expect(result.action).toBe("already_present")
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8")).plugin).toEqual(["opencode-compact-lsp"])
  })

  test("leaves sibling plugins in place", () => {
    writeFileSync(
      join(configDir, "opencode.json"),
      `${JSON.stringify({ plugin: ["other-plugin", "opencode-compact-lsp"], model: "keep-me" }, null, 2)}\n`,
    )
    const result = ensurePluginEntry("opencode-compact-lsp", configDir)
    expect(result.action).toBe("already_present")
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8"))).toEqual({
      plugin: ["other-plugin", "opencode-compact-lsp"],
      model: "keep-me",
    })
  })

  test("preserves jsonc comments when adding a sibling plugin", () => {
    writeFileSync(
      join(configDir, "opencode.jsonc"),
      `{
  // keep this comment
  "plugin": ["other-plugin"]
}
`,
    )
    const result = ensurePluginEntry("opencode-compact-lsp", configDir)
    expect(result.ok).toBe(true)
    expect(result.configPath).toBe(join(configDir, "opencode.jsonc"))
    const text = readFileSync(join(configDir, "opencode.jsonc"), "utf-8")
    expect(text).toContain("//")
    expect(text).toContain("other-plugin")
    expect(text).toContain("opencode-compact-lsp")
  })

  test("prefers opencode.jsonc when both json and jsonc exist", () => {
    writeFileSync(
      join(configDir, "opencode.json"),
      `${JSON.stringify({ plugin: ["from-json"] }, null, 2)}\n`,
    )
    writeFileSync(
      join(configDir, "opencode.jsonc"),
      `${JSON.stringify({ plugin: ["from-jsonc"] }, null, 2)}\n`,
    )
    const result = ensurePluginEntry("opencode-compact-lsp", configDir)
    expect(result.configPath).toBe(join(configDir, "opencode.jsonc"))
    expect(JSON.parse(readFileSync(join(configDir, "opencode.jsonc"), "utf-8")).plugin).toEqual([
      "from-jsonc",
      "opencode-compact-lsp",
    ])
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8"))).toEqual({
      plugin: ["from-json"],
    })
  })

  test("pins an unpinned string entry and keeps a single plugin slot", () => {
    writeFileSync(
      join(configDir, "opencode.json"),
      `${JSON.stringify({ plugin: ["opencode-compact-lsp"] }, null, 2)}\n`,
    )
    const result = ensurePluginEntry("opencode-compact-lsp@0.1.0", configDir)
    expect(result.action).toBe("updated")
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8")).plugin).toEqual([
      "opencode-compact-lsp@0.1.0",
    ])
  })

  test("replaces an options tuple with a spec string", () => {
    writeFileSync(
      join(configDir, "opencode.json"),
      `${JSON.stringify(
        { plugin: [["opencode-compact-lsp", { compact: true, minified: true, extra: 1 }]] },
        null,
        2,
      )}\n`,
    )
    const result = ensurePluginEntry("opencode-compact-lsp", configDir)
    expect(result.action).toBe("updated")
    expect(JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8")).plugin).toEqual(["opencode-compact-lsp"])
  })
})

describe("ensureTuiPluginEntry", () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "compact-lsp-tui-"))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  test("creates tui.json with a string spec", () => {
    const result = ensureTuiPluginEntry("opencode-compact-lsp", configDir)
    expect(result.ok).toBe(true)
    expect(result.action).toBe("added")
    expect(result.configPath).toBe(join(configDir, "tui.json"))
    expect(JSON.parse(readFileSync(join(configDir, "tui.json"), "utf-8"))).toEqual({
      plugin: ["opencode-compact-lsp"],
    })
  })

  test("second call with the same spec is already_present", () => {
    ensureTuiPluginEntry("opencode-compact-lsp", configDir)
    const result = ensureTuiPluginEntry("opencode-compact-lsp", configDir)
    expect(result.action).toBe("already_present")
  })

  test("replaces an unpinned spec with a pinned spec in place", () => {
    ensureTuiPluginEntry("opencode-compact-lsp", configDir)
    const result = ensureTuiPluginEntry("opencode-compact-lsp@0.1.0", configDir)
    expect(result.action).toBe("updated")
    expect(JSON.parse(readFileSync(join(configDir, "tui.json"), "utf-8")).plugin).toEqual(["opencode-compact-lsp@0.1.0"])
  })

  test("keeps a single slot when replacing @latest then @next", () => {
    ensureTuiPluginEntry("opencode-compact-lsp@0.1.0", configDir)
    ensureTuiPluginEntry("opencode-compact-lsp@latest", configDir)
    ensureTuiPluginEntry("opencode-compact-lsp@next", configDir)
    expect(JSON.parse(readFileSync(join(configDir, "tui.json"), "utf-8")).plugin).toEqual(["opencode-compact-lsp@next"])
  })
})

describe("matchesPluginEntry", () => {
  test("matches the package name, @tag, and tuple form", () => {
    expect(matchesPluginEntry("opencode-compact-lsp")).toBe(true)
    expect(matchesPluginEntry("other")).toBe(false)
    expect(matchesPluginEntry(["opencode-compact-lsp", { compact: true, minified: true }])).toBe(true)
    expect(matchesPluginEntry("opencode-compact-lsp@latest")).toBe(true)
  })

  test("does not match a relative plugin path", () => {
    expect(matchesPluginEntry("../opencode-compact-lsp/src/plugin.ts")).toBe(false)
  })

  test("matches a file URL of this package plugin.ts", () => {
    expect(matchesPluginEntry(pathToFileURL(pluginTs).href)).toBe(true)
  })
})

describe("configDirForScope", () => {
  test("project scope is cwd/.opencode", () => {
    expect(configDirForScope("project", "/tmp/proj")).toBe(join("/tmp/proj", ".opencode"))
  })
})

describe("pluginCacheDirs", () => {
  test("lists only this package name and name@version dirs", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "compact-lsp-cachedirs-"))
    mkdirSync(join(cacheDir, "packages", "opencode-compact-lsp"), { recursive: true })
    mkdirSync(join(cacheDir, "packages", "opencode-compact-lsp@latest"), { recursive: true })
    mkdirSync(join(cacheDir, "packages", "other@1.0.0"), { recursive: true })
    mkdirSync(join(cacheDir, "packages", "opencode-compact-lsp-extra"), { recursive: true })
    expect(pluginCacheDirs(cacheDir).sort()).toEqual(
      [
        join(cacheDir, "packages", "opencode-compact-lsp"),
        join(cacheDir, "packages", "opencode-compact-lsp@latest"),
      ].sort(),
    )
    rmSync(cacheDir, { recursive: true, force: true })
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
