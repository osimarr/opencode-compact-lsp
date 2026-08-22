import { describe, expect, test } from "bun:test"
import { detectCli, invokedSpecTag, pluginSpec } from "./detect"

describe("detectCli", () => {
  test("npx invocation", () => {
    expect(
      detectCli({
        userAgent: "npm/10.9.2 node/v22.0.0",
        argv1: "/tmp/npx-123/node_modules/opencode-compact-lsp/src/cli.ts",
      }),
    ).toBe("npx opencode-compact-lsp")
  })

  test("bunx invocation", () => {
    expect(
      detectCli({
        userAgent: "bun/1.2.0",
        argv1: "/home/user/.bun/install/cache/opencode-compact-lsp@0.1.0/src/cli.ts",
      }),
    ).toBe("bunx opencode-compact-lsp")
  })

  test("installed binary", () => {
    expect(detectCli({ userAgent: "", argv1: "/usr/local/bin/opencode-compact-lsp" })).toBe("opencode-compact-lsp")
  })
})

describe("pluginSpec", () => {
  test("pins version for bunx and npx", () => {
    expect(pluginSpec("bunx opencode-compact-lsp", "0.2.0")).toBe("opencode-compact-lsp@0.2.0")
    expect(pluginSpec("npx opencode-compact-lsp", "0.2.0")).toBe("opencode-compact-lsp@0.2.0")
  })

  test("keeps @latest and @next from the invocation path", () => {
    expect(
      pluginSpec(
        "bunx opencode-compact-lsp",
        "0.2.3",
        "/tmp/bunx-1000-opencode-compact-lsp@latest/node_modules/opencode-compact-lsp/dist/cli.js",
      ),
    ).toBe("opencode-compact-lsp@latest")
    expect(
      pluginSpec(
        "npx opencode-compact-lsp",
        "0.2.3",
        "/tmp/npx-123/opencode-compact-lsp@next/node_modules/opencode-compact-lsp/dist/cli.js",
      ),
    ).toBe("opencode-compact-lsp@next")
  })

  test("keeps an explicit version from the invocation path", () => {
    expect(
      pluginSpec(
        "bunx opencode-compact-lsp",
        "0.2.3",
        "/tmp/bunx-1000-opencode-compact-lsp@0.2.1/node_modules/opencode-compact-lsp/dist/cli.js",
      ),
    ).toBe("opencode-compact-lsp@0.2.1")
  })

  test("does not pin for the installed binary", () => {
    expect(pluginSpec("opencode-compact-lsp", "0.2.0")).toBe("opencode-compact-lsp")
    expect(pluginSpec("opencode-compact-lsp", "0.2.0", "/usr/local/bin/opencode-compact-lsp")).toBe(
      "opencode-compact-lsp",
    )
  })

  test("keeps @latest from the path even if the cli looks like a binary", () => {
    expect(pluginSpec("opencode-compact-lsp", "0.2.3", "/tmp/x/opencode-compact-lsp@latest/cli.js")).toBe(
      "opencode-compact-lsp@latest",
    )
  })

  test("prefers @latest/@next over a resolved version in the same haystack", () => {
    expect(
      invokedSpecTag(
        "/tmp/bunx-1000-opencode-compact-lsp@0.2.5/node_modules/opencode-compact-lsp/dist/cli.js bunx opencode-compact-lsp@latest install",
      ),
    ).toBe("latest")
    expect(
      pluginSpec(
        "bunx opencode-compact-lsp",
        "0.2.5",
        "bunx opencode-compact-lsp@latest install /tmp/opencode-compact-lsp@0.2.5/cli.js",
      ),
    ).toBe("opencode-compact-lsp@latest")
    expect(pluginSpec("npx opencode-compact-lsp", "0.2.5", "npx opencode-compact-lsp@next install")).toBe(
      "opencode-compact-lsp@next",
    )
  })
})
