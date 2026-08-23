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
  test("minified false defaults compact true", () => {
    expect(resolveOptions({ minified: false })).toEqual({ compact: true, minified: false })
  })
  test("non-false compact junk defaults true", () => {
    expect(resolveOptions({ compact: "false" })).toEqual({ compact: true, minified: true })
    expect(resolveOptions({ compact: 0 })).toEqual({ compact: true, minified: true })
    expect(resolveOptions({ compact: null })).toEqual({ compact: true, minified: true })
    expect(resolveOptions({ compact: undefined })).toEqual({ compact: true, minified: true })
  })
})
