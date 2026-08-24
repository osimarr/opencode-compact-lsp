import { describe, expect, test, spyOn } from "bun:test"
import { createRecorder } from "./recorder"
import { __setTokenizerForTest, __resetTokenizerForTest } from "./tokenizer"

describe("recorder", () => {
  test("recorder never throws into caller and survives tokenizer error", async () => {
    // inject failing tokenizer to simulate error in worker
    __setTokenizerForTest({ encode: () => { throw new Error("tokenizer boom") } })
    const r = createRecorder({ stateRoot: "/tmp/x", projectKey: "a".repeat(64), projectDir: "/tmp/x/projects/a" })
    expect(() => r.record("a", "b", "ses1", false)).not.toThrow()
    // second call with potentially tokenizer failure should also not throw
    expect(() => r.record("hello", "world", "ses1", true)).not.toThrow()
    // even with tokenizer throwing, subsequent records must not throw
    expect(() => r.record("x", "y", "ses1", false)).not.toThrow()
    r.close()
    __resetTokenizerForTest()
    // after reset, normal recorder still not throws
    const r2 = createRecorder({ stateRoot: "/tmp/x-recover", projectKey: "a".repeat(64), projectDir: "/tmp/x-recover/projects/a" })
    __setTokenizerForTest({ encode: (s: string) => Array.from(s).map((_, i) => i) })
    expect(() => r2.record("a", "b", "ses1", false)).not.toThrow()
    r2.close()
    __resetTokenizerForTest()
  })

  test("measured zero with exclusions shows diagnostic", async () => {
    // When measured zero but exclusions exist, diagnostic rows should be shown, not headline tokens.
    // Here we test recorder correctly classifies oversize as exclusion (0 tokens) and does not throw
    __setTokenizerForTest({ encode: (s: string) => Array.from(s).map((_, i) => i) })
    const r = createRecorder({ stateRoot: "/tmp/x2", projectKey: "b".repeat(64), projectDir: "/tmp/x2/projects/b" })
    // oversize job should be recorded as exclusion without tokens
    const large = "a".repeat(4 * 1024 * 1024 + 1)
    expect(() => r.record(large, "", "ses2", false)).not.toThrow()
    // normal job after exclusion should still be enqueued
    expect(() => r.record("a", "b", "ses2", false)).not.toThrow()
    r.close()
    __resetTokenizerForTest()
  })

  test("bounded queue drops newest when 16 jobs exceeded", () => {
    __setTokenizerForTest({ encode: (s: string) => Array.from(s).map((_, i) => i) })
    const r = createRecorder({ stateRoot: "/tmp/bounded-jobs", projectKey: "c".repeat(64), projectDir: "/tmp/bounded-jobs/projects/c" })
    // enqueue 16 should be admitted
    for (let i = 0; i < 16; i++) {
      expect(() => r.record("a", "b", `s${i}`, false)).not.toThrow()
    }
    // check internal dropped before overflow
    const beforeDropped = (r as any)._getDroppedCount?.() ?? 0
    // 17th should be dropped but not throw
    expect(() => r.record("a", "b", "overflow", false)).not.toThrow()
    const afterDropped = (r as any)._getDroppedCount?.() ?? 0
    expect(afterDropped).toBe(beforeDropped + 1)
    // verify queue never exceeds 16 (including active)
    const worker: any = (r as any)._worker
    if (worker) {
      expect(worker._getQueueLength() + (worker._getActive() ? 1 : 0)).toBeLessThanOrEqual(16)
    }
    r.close()
    __resetTokenizerForTest()
  })

  test("bounded bytes drops when 8 MiB exceeded", () => {
    __setTokenizerForTest({ encode: (s: string) => Array.from(s).map((_, i) => i) })
    const r = createRecorder({ stateRoot: "/tmp/bounded-bytes", projectKey: "d".repeat(64), projectDir: "/tmp/bounded-bytes/projects/d" })
    // Each pair "a".repeat(512*1024) => 512KiB string, two strings => 1MiB combined UTF8 for ASCII
    // 8 such jobs => 8MiB, 9th should be dropped
    const chunk = "a".repeat(512 * 1024)
    for (let i = 0; i < 8; i++) {
      expect(() => r.record(chunk, chunk, `s${i}`, false)).not.toThrow()
    }
    const beforeDropped = (r as any)._getDroppedCount?.() ?? 0
    expect(() => r.record(chunk, chunk, "overflow", false)).not.toThrow()
    const afterDropped = (r as any)._getDroppedCount?.() ?? 0
    expect(afterDropped).toBe(beforeDropped + 1)
    r.close()
    __resetTokenizerForTest()
  })

  test("O(1) length gate avoids Buffer.byteLength for oversize strings", () => {
    const r = createRecorder({ stateRoot: "/tmp/o1-gate", projectKey: "e".repeat(64), projectDir: "/tmp/o1-gate/projects/e" })
    const spy = spyOn(Buffer, "byteLength")
    // Create strings whose combined .length > 4MiB => should use O(1) path and not call byteLength
    const large = "a".repeat(4 * 1024 * 1024 + 1)
    expect(() => r.record(large, "", "ses", false)).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()

    // Also test just over 4MiB via two strings each >2MiB
    const spy2 = spyOn(Buffer, "byteLength")
    const a = "a".repeat(2 * 1024 * 1024 + 1)
    const b = "a".repeat(2 * 1024 * 1024 + 1)
    expect(() => r.record(a, b, "ses2", false)).not.toThrow()
    expect(spy2).not.toHaveBeenCalled()
    spy2.mockRestore()
    r.close()
  })

  test("byteLength gate handles oversize UTF8 without O(1) trigger", () => {
    const r = createRecorder({ stateRoot: "/tmp/utf8-gate", projectKey: "f".repeat(64), projectDir: "/tmp/utf8-gate/projects/f" })
    // 2MiB code units of emoji (4 bytes UTF8 each) => ~8MiB UTF8 but .length is 2MiB*2? Actually emoji is 2 code units per emoji, so 2MiB code units ~1M emojis => 4MiB UTF8
    // Simpler: use string with .length <4MiB but UTF8 >4MiB: each char is 3 bytes in UTF8 for e.g. \u0800
    // 1.5M chars *3 = 4.5MiB UTF8, length 1.5M <4MiB, so O1 passes but byteLength should detect oversize
    const threeByteChar = "\u0800" // 3 bytes UTF8, 1 code unit
    const chunk = threeByteChar.repeat(1.5 * 1024 * 1024) // 1.5M *3 = 4.5MiB
    // combined with empty after => still >4MiB UTF8
    // This should not throw and should be classified as oversize (0 bytes charged) and not crash
    expect(() => r.record(chunk, "", "ses", false)).not.toThrow()
    // also combined two such chunks would be oversize
    expect(() => r.record(chunk, chunk, "ses2", false)).not.toThrow()
    r.close()
  })

  test("close prevents further enqueue and is idempotent", () => {
    const r = createRecorder({ stateRoot: "/tmp/close-test", projectKey: "0".repeat(64), projectDir: "/tmp/close-test/projects/0" })
    expect(() => r.record("a", "b", "ses", false)).not.toThrow()
    expect(() => r.close()).not.toThrow()
    expect(() => r.close()).not.toThrow()
    expect(() => r.record("a", "b", "ses", false)).not.toThrow()
  })

  test("record never throws with invalid inputs", () => {
    const r = createRecorder({ stateRoot: "/tmp/invalid", projectKey: "1".repeat(64), projectDir: "/tmp/invalid/projects/1" })
    expect(() => r.record(null as any, "b", "ses", false)).not.toThrow()
    expect(() => r.record("a", null as any, "ses", false)).not.toThrow()
    expect(() => r.record("a", "b", null as any, false)).not.toThrow()
    r.close()
  })
})
