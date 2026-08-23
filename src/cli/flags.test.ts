import { describe, expect, test } from "bun:test"
import { installScope, skipClearConfirm } from "./flags"

describe("skipClearConfirm", () => {
  test("skips when --yes", () => {
    expect(skipClearConfirm(["--clear", "--yes"], {})).toBe(true)
  })
  test("skips when CI=true", () => {
    expect(skipClearConfirm(["--clear"], { CI: "true" })).toBe(true)
  })
  test("does not skip on a TTY-like env without --yes", () => {
    expect(skipClearConfirm(["--clear"], {})).toBe(false)
  })
})

describe("installScope", () => {
  test("reads --global and --project", () => {
    expect(installScope(["--global"])).toBe("global")
    expect(installScope(["--project"])).toBe("project")
    expect(installScope([])).toBe(undefined)
  })
  test("rejects both flags", () => {
    expect(installScope(["--global", "--project"])).toBe("conflict")
  })
})
