import { describe, expect, test } from "bun:test"
import { resolveOptions } from "./options"

describe("resolveOptions", () => {
  test("omitted flags default true", () => {
    expect(resolveOptions(undefined)).toEqual({ compact: true, minified: true })
    expect(resolveOptions({})).toEqual({ compact: true, minified: true })
  })
  test("explicit false wins", () => {
    expect(resolveOptions({ compact: false, minified: false })).toEqual({ compact: false, minified: false })
  })
  test("mixed", () => {
    expect(resolveOptions({ compact: false })).toEqual({ compact: false, minified: true })
  })
})
