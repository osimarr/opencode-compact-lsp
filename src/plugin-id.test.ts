import { describe, expect, test } from "bun:test"
import { pluginId } from "./plugin-id"

describe("pluginId", () => {
  test("uses package name for npm and dist installs", () => {
    expect(pluginId("file:///home/david/.cache/opencode/packages/opencode-compact-lsp@0.1.0/node_modules/opencode-compact-lsp/src/tui.ts")).toBe(
      "opencode-compact-lsp",
    )
    expect(pluginId("file:///tmp/opencode-compact-lsp/dist/tui.js")).toBe("opencode-compact-lsp")
  })
  test("uses -dev suffix for local source", () => {
    expect(pluginId("file:///home/david/projects/opencode/opencode-compact-lsp/src/tui.ts")).toBe(
      "opencode-compact-lsp-dev",
    )
  })
})
