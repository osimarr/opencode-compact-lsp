import { describe, expect, test } from "bun:test"
import { deriveProjectKey, deriveSessionKey } from "./identity"

const key = Buffer.from([...Array(32).keys()])

describe("identity", () => {
  test("golden project/session vectors", () => {
    expect(deriveProjectKey(key, "/repo/.git")).toBe(
      "9877aa91fdb53af2fb9b1089b1db1c6e47f352b8ac10f2ac57bdafdeeee9463a",
    )
    const pk = deriveProjectKey(key, "/repo/.git")
    expect(deriveSessionKey(key, pk, "ses_123")).toBe(
      "85c4febf5950d803cc78712e340004ff787a33d84c13d4a19207e39f0ded717f",
    )
  })
  test("different raw identities produce different keys", () => {
    expect(deriveProjectKey(key, "/a")).not.toBe(deriveProjectKey(key, "/b"))
  })
})
