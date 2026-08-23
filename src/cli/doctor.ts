import { execFileSync } from "node:child_process"
import { confirm, intro, isCancel, log, note, outro } from "@clack/prompts"
import { resolveOptions, type CompactLspOptions } from "../options"
import {
  clearPluginCaches,
  configDirForScope,
  defaultPluginSpec,
  hasPluginEntry,
  hasTuiPluginEntry,
  matchesPluginEntry,
  PLUGIN_NAME,
  registerPlugin,
} from "./config"
import { detectCli } from "./detect"
import type { FlagTriple, InstallScopeFlag } from "./flags"
import { flagConflictMessage } from "./install"
import { detectJsoncFile, readJsoncFile } from "./jsonc"
import { resolveInstallScope } from "./scope"
import { opencodeVersionOk } from "./version"

function hostVersion(): string | undefined {
  try {
    return execFileSync("opencode", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim()
  } catch {
    return undefined
  }
}

function tupleOptions(configDir: string): CompactLspOptions | undefined {
  const file = detectJsoncFile(configDir, "opencode")
  if (file.format === "none") return undefined
  const { value } = readJsoncFile(file.path)
  const plugins = Array.isArray(value?.plugin) ? value.plugin : []
  const entry = plugins.find((item) => matchesPluginEntry(item))
  if (!Array.isArray(entry) || !entry[1] || typeof entry[1] !== "object" || Array.isArray(entry[1])) return undefined
  return resolveOptions(entry[1] as Record<string, unknown>)
}

function diagnosticConfigDir(scope: InstallScopeFlag | undefined): string | undefined {
  if (scope === "conflict") return undefined
  if (scope === "global" || scope === "project") return configDirForScope(scope)
  return configDirForScope("global")
}

export async function runDoctor(options: {
  fix: boolean
  clear: boolean
  yes?: boolean
  scope?: InstallScopeFlag
  compact?: FlagTriple
  minified?: FlagTriple
}): Promise<number> {
  const cli = detectCli()
  intro(`${cli} doctor`)

  if (options.clear) {
    if (!options.yes) {
      const confirmed = await confirm({ message: `Clear OpenCode plugin cache for ${PLUGIN_NAME}?` })
      if (isCancel(confirmed) || !confirmed) {
        outro("Done.")
        return 0
      }
    }
    const result = clearPluginCaches()
    if (result.cleared === 0 && result.errors === 0) log.info(`No ${PLUGIN_NAME} plugin cache to clear.`)
    else log.success(`Cleared ${result.cleared} cache dir(s).`)
    if (result.errors > 0) {
      log.error(`${result.errors} cache dir(s) could not be cleared.`)
      outro("Done — some cache entries could not be cleared.")
      return 1
    }
    outro("Done.")
    return 0
  }

  if (options.fix) {
    const conflict = flagConflictMessage(options.compact, options.minified)
    if (conflict) {
      log.error(conflict)
      outro("Fix failed.")
      return 1
    }
    const scope = await resolveInstallScope(options.scope)
    if (!scope) {
      outro("Fix cancelled.")
      return 1
    }
    const pluginOptions = resolveOptions({ compact: options.compact, minified: options.minified })
    const result = registerPlugin(defaultPluginSpec(), pluginOptions, configDirForScope(scope))
    if (!result.ok) {
      if (!result.server.ok) log.error(result.server.message)
      if (!result.tui.ok) log.error(result.tui.message)
      outro("Fix failed.")
      return 1
    }
    log.success(result.server.message)
    log.success(result.tui.message)
    note("Restart OpenCode so the plugin loads.", "Next steps")
    outro("Done.")
    return 0
  }

  let problems = false
  const version = hostVersion()
  if (!version) {
    log.warn("  host not installed — install OpenCode: https://opencode.ai/docs/install")
    problems = true
  } else {
    log.info(`  host: ${version}`)
    if (!opencodeVersionOk(version)) {
      log.warn("  could not parse OpenCode version")
      problems = true
    }
  }

  const configDir = diagnosticConfigDir(options.scope)
  if (!configDir) {
    log.error("Use either --global or --project, not both.")
    outro("Done — some issues found.")
    return 1
  }

  const opencode = detectJsoncFile(configDir, "opencode")
  if (opencode.format === "none") {
    log.warn(`  opencode config: (not set) — run \`${cli} install\``)
    problems = true
  } else {
    const parsed = readJsoncFile(opencode.path)
    if (parsed.error) {
      log.error(`  opencode config parse error: ${parsed.error}`)
      problems = true
    } else {
      log.info(`  opencode config: ${opencode.path}`)
    }
  }

  const registered = hasPluginEntry(configDir)
  const tuiRegistered = hasTuiPluginEntry(configDir)
  log.info(`  opencode.json plugin: ${registered ? "yes" : "no"}`)
  log.info(`  tui.json plugin: ${tuiRegistered ? "yes" : "no"}`)
  if (!registered || !tuiRegistered) {
    log.warn(`  plugin registration can be fixed with \`${cli} install\` or \`${cli} doctor --fix\``)
    problems = true
  }
  const optionsFromTuple = tupleOptions(configDir)
  if (optionsFromTuple) {
    log.info(`  options: compact=${optionsFromTuple.compact} minified=${optionsFromTuple.minified}`)
  }

  if (problems) {
    note(
      `Run \`${cli} install\` or \`${cli} doctor --fix\` to register ${PLUGIN_NAME} in opencode.json and tui.json.`,
      "Tips",
    )
    outro("Done — some issues found.")
    return 1
  }
  outro("Everything looks good.")
  return 0
}
