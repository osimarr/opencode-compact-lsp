import { describe, expect, test } from "bun:test"
import mod from "./tui"

describe("tui module", () => {
  test("exports a TUI-only plugin with a file-plugin id", () => {
    expect(mod.id).toBe("opencode-compact-lsp-dev")
    expect(typeof mod.tui).toBe("function")
    expect("server" in mod).toBe(false)
  })
})
