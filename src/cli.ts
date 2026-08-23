#!/usr/bin/env node
import { detectCli } from "./cli/detect"
import { runDoctor } from "./cli/doctor"
import { compactFlag, installScope, minifiedFlag, skipClearConfirm } from "./cli/flags"
import { runInstall } from "./cli/install"
import { runningPackageVersion } from "./cli/version"

const command = process.argv[2]
const args = process.argv.slice(3)

function printHelp(): void {
  const cli = detectCli()
  const version = runningPackageVersion()
  console.log("")
  console.log(`  opencode-compact-lsp ${version}`)
  console.log("  --------------------")
  console.log("")
  console.log("  Commands:")
  console.log("    install            Register the plugin in opencode.json and tui.json")
  console.log("    install --global   Global (~/.config/opencode)")
  console.log("    install --project  Project (.opencode/opencode.json and tui.json)")
  console.log("    install --compact / --no-compact")
  console.log("    install --minified / --no-minified")
  console.log("    doctor             Check OpenCode + opencode.json and tui.json registration")
  console.log("    doctor --fix       Register the plugin if missing")
  console.log("    doctor --clear     Clear the OpenCode plugin npm cache")
  console.log("")
  console.log("  Usage:")
  console.log(`    ${cli} install`)
  console.log(`    ${cli} doctor`)
  console.log(`    ${cli} doctor --fix`)
  console.log(`    ${cli} doctor --clear`)
  console.log("")
}

async function main(): Promise<number> {
  if (command === "--version" || command === "-v") {
    console.log(runningPackageVersion())
    return 0
  }
  if (command === "--help" || command === "-h") {
    printHelp()
    return 0
  }
  if (command === "install" || command === "setup") {
    return runInstall({
      scope: installScope(args),
      compact: compactFlag(args),
      minified: minifiedFlag(args),
    })
  }
  if (command === "doctor") {
    return runDoctor({
      fix: args.includes("--fix"),
      clear: args.includes("--clear"),
      yes: skipClearConfirm(args),
      scope: installScope(args),
      compact: compactFlag(args),
      minified: minifiedFlag(args),
    })
  }
  printHelp()
  return command ? 1 : 0
}

main().then((code) => process.exit(code))
