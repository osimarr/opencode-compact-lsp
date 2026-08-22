import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse } from "node:path"
import { fileURLToPath } from "node:url"
import type { CompactLspOptions } from "../options"
import { detectCli, pluginSpec } from "./detect"
import type { InstallScope } from "./flags"
import { detectJsoncFile, readJsoncFile, writeJsoncFile } from "./jsonc"
import { runningPackageVersion } from "./version"

export const PLUGIN_NAME = "opencode-compact-lsp"

export function defaultPluginSpec(): string {
  const haystack = [process.argv.join(" "), import.meta.url, parentCommandLine()].join(" ")
  return pluginSpec(detectCli(), runningPackageVersion(), haystack)
}

export type PluginEntryResult = {
  ok: boolean
  action: "added" | "already_present" | "updated" | "error"
  message: string
  configPath: string
}

function parentCommandLine(): string {
  try {
    return readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").replace(/\0/g, " ")
  } catch {
    return ""
  }
}

function getOpenCodeConfigDir(): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (envDir) return envDir
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "opencode")
}

export function configDirForScope(scope: InstallScope, cwd = process.cwd()): string {
  if (scope === "project") return join(cwd, ".opencode")
  return getOpenCodeConfigDir()
}

export function getOpenCodeCacheDir(): string {
  const envDir = process.env.OPENCODE_CACHE_DIR?.trim()
  if (envDir) return envDir
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg) return join(xdg, "opencode")
  return join(homedir(), ".cache", "opencode")
}

function pathFromEntry(entry: string): string | null {
  if (entry.startsWith("file://")) {
    try {
      return fileURLToPath(entry)
    } catch {
      return null
    }
  }
  if (entry.startsWith("/") || /^[A-Za-z]:[/\\]/.test(entry)) return entry
  return null
}

function pathPointsToOurPlugin(entry: string): boolean {
  const fsPath = pathFromEntry(entry)
  if (!fsPath || !existsSync(fsPath)) return false
  let searchDir = statSync(fsPath).isDirectory() ? fsPath : dirname(fsPath)
  while (true) {
    const candidate = join(searchDir, "package.json")
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown }
        return parsed.name === PLUGIN_NAME
      } catch {
        return false
      }
    }
    const parent = dirname(searchDir)
    if (parent === searchDir || searchDir === parse(searchDir).root) return false
    searchDir = parent
  }
}

function specMatches(entry: string): boolean {
  if (entry === PLUGIN_NAME) return true
  if (entry.startsWith(`${PLUGIN_NAME}@`)) return true
  return pathPointsToOurPlugin(entry)
}

export function matchesPluginEntry(entry: unknown): boolean {
  if (typeof entry === "string") return specMatches(entry)
  if (Array.isArray(entry) && typeof entry[0] === "string") return specMatches(entry[0])
  return false
}

function entryName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

function optionsDeepEqual(existing: unknown, options: CompactLspOptions): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false
  const rec = existing as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 2 || !("compact" in rec) || !("minified" in rec)) return false
  return rec.compact === options.compact && rec.minified === options.minified
}

function pluginTuple(spec: string, options: CompactLspOptions): [string, CompactLspOptions] {
  return [spec, { compact: options.compact, minified: options.minified }]
}

export function hasPluginEntry(configDir = getOpenCodeConfigDir()): boolean {
  const file = detectJsoncFile(configDir, "opencode")
  if (file.format === "none") return false
  const { value } = readJsoncFile(file.path)
  const plugins = Array.isArray(value?.plugin) ? value.plugin : []
  return plugins.some((entry) => matchesPluginEntry(entry))
}

export function ensurePluginEntry(spec: string, options: CompactLspOptions, configDir: string): PluginEntryResult {
  const file = detectJsoncFile(configDir, "opencode")
  const configPath = file.path
  const tuple = pluginTuple(spec, options)
  if (file.format === "none") {
    writeJsoncFile(configPath, { plugin: [tuple] }, "json")
    return {
      ok: true,
      action: "added",
      message: `Created ${configPath} and added ${spec}`,
      configPath,
    }
  }
  const { value, error } = readJsoncFile(configPath)
  if (error || !value) {
    return {
      ok: false,
      action: "error",
      message: `Could not parse ${configPath}: ${error ?? "unknown error"}`,
      configPath,
    }
  }
  const plugins = Array.isArray(value.plugin) ? [...value.plugin] : []
  const index = plugins.findIndex((entry) => matchesPluginEntry(entry))
  if (index >= 0) {
    const existing = plugins[index]
    if (entryName(existing) === spec && Array.isArray(existing) && optionsDeepEqual(existing[1], options)) {
      return {
        ok: true,
        action: "already_present",
        message: `${spec} is already registered in ${configPath}`,
        configPath,
      }
    }
    plugins[index] = tuple
    value.plugin = plugins
    writeJsoncFile(configPath, value, file.format)
    return {
      ok: true,
      action: "updated",
      message: `Updated ${configPath} to ${spec}`,
      configPath,
    }
  }
  plugins.push(tuple)
  value.plugin = plugins
  writeJsoncFile(configPath, value, file.format)
  return {
    ok: true,
    action: "added",
    message: `Added ${spec} to ${configPath}`,
    configPath,
  }
}

export function pluginCacheDirs(cacheDir = getOpenCodeCacheDir()): string[] {
  const packages = join(cacheDir, "packages")
  if (!existsSync(packages)) return []
  return readdirSync(packages)
    .filter((name) => name === PLUGIN_NAME || name.startsWith(`${PLUGIN_NAME}@`))
    .map((name) => join(packages, name))
}

export function clearPluginCaches(cacheDir = getOpenCodeCacheDir()): { cleared: number; errors: number } {
  let cleared = 0
  let errors = 0
  for (const dir of pluginCacheDirs(cacheDir)) {
    try {
      rmSync(dir, { recursive: true, force: true })
      cleared += 1
    } catch {
      errors += 1
    }
  }
  return { cleared, errors }
}
