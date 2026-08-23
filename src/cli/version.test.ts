import { describe, expect, test } from "bun:test"
import { opencodeVersionOk } from "./version"

describe("opencodeVersionOk", () => {
  test("any x.y.z is ok", () => {
    expect(opencodeVersionOk("1.0.0")).toBe(true)
    expect(opencodeVersionOk("0.1.0")).toBe(true)
    expect(opencodeVersionOk("1.18.0")).toBe(true)
    expect(opencodeVersionOk("not-a-version")).toBe(false)
  })

  test("matches x.y.z as a substring and rejects two-part versions", () => {
    expect(opencodeVersionOk("v1.18.0")).toBe(true)
    expect(opencodeVersionOk("opencode 1.0.0 (build)")).toBe(true)
    expect(opencodeVersionOk("1.2")).toBe(false)
    expect(opencodeVersionOk("")).toBe(false)
  })
})
