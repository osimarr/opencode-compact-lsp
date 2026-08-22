import { describe, expect, test } from "bun:test"
import { compactFlag, installScope, minifiedFlag, skipClearConfirm } from "./flags"

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

describe("compactFlag", () => {
  test("reads compact flags", () => {
    expect(compactFlag(["--compact"])).toBe(true)
    expect(compactFlag(["--no-compact"])).toBe(false)
    expect(compactFlag(["--compact", "--no-compact"])).toBe("conflict")
    expect(compactFlag([])).toBe(undefined)
  })
})

describe("minifiedFlag", () => {
  test("reads minified flags", () => {
    expect(minifiedFlag(["--minified"])).toBe(true)
    expect(minifiedFlag(["--no-minified"])).toBe(false)
    expect(minifiedFlag(["--minified", "--no-minified"])).toBe("conflict")
    expect(minifiedFlag([])).toBe(undefined)
  })
})
