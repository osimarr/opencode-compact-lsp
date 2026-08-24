import type { Plugin } from "@opencode-ai/plugin"
import { resolveOptions } from "./options"
import { applyLspOutput } from "./format"
import { createRecorder as defaultCreateRecorder } from "./stats/recorder"
import type { Recorder } from "./stats/recorder"
import * as path from "node:path"
import { canonicalProjectIdentity, deriveProjectKey, resolveStateRoot } from "./stats/identity"
import { ensureIdentityKey } from "./stats/identity-store"

let testFactory: typeof defaultCreateRecorder | null = null
let testRecorder: Recorder | null = null

export function __setRecorderFactoryForTest(factory: typeof defaultCreateRecorder | null): void {
  testFactory = factory
}
export function __resetRecorderFactoryForTest(): void {
  testFactory = null
}
export function __setRecorderForTest(recorder: Recorder | null): void {
  testRecorder = recorder
}
export function __resetRecorderForTest(): void {
  testRecorder = null
}

export default (async (_input, raw) => {
  const options = resolveOptions(raw)
  let recorder: Recorder | null = null

  if (testRecorder) {
    recorder = testRecorder
  } else {
    const factory = testFactory ?? defaultCreateRecorder
    const hasDirectory = typeof (_input as any)?.directory === "string" && (_input as any).directory.length > 0
    const shouldAttempt = hasDirectory || testFactory !== null
    if (shouldAttempt) {
      let ctx: { stateRoot: string; projectKey: string; projectDir: string; identityKey: Buffer | null } | null = null
      try {
        if (hasDirectory) {
          const directory = (_input as any).directory as string
          let stateRoot: string
          try {
            stateRoot = resolveStateRoot(process.env as unknown as NodeJS.ProcessEnv)
          } catch {
            // invalid XDG or missing HOME/LOCALAPPDATA -> stats unavailable (fail-open)
            throw new Error("state root unavailable")
          }
          let canonical: string
          try {
            canonical = await canonicalProjectIdentity(directory)
          } catch {
            canonical = directory
          }
          const key32 = await ensureIdentityKey(stateRoot)
          if (!key32) {
            // orphaned or malformed identity → stats unavailable, do not create recorder
            ctx = null
          } else {
            const projectKey = deriveProjectKey(key32, canonical)
            const projectDir = path.join(stateRoot, "projects", projectKey)
            ctx = { stateRoot, projectKey, projectDir, identityKey: key32 }
          }
        } else {
          // test-only dummy ctx when factory is injected but no directory (e.g., {} as input)
          const stateRoot = path.join("/tmp", "opencode-compact-lsp-test")
          const projectKey = "a".repeat(64)
          const projectDir = path.join(stateRoot, "projects", projectKey)
          // synthetic 32-byte key for test (do not log)
          const identityKey = Buffer.alloc(32, 0x61)
          ctx = { stateRoot, projectKey, projectDir, identityKey }
        }
      } catch {
        ctx = null
      }
      if (ctx) {
        try {
          recorder = factory(ctx)
        } catch {
          recorder = null
        }
      }
    }
  }

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "lsp") return
      const before = output.output
      const truncated = output.metadata?.truncated === true
      output.output = applyLspOutput(options, output)
      const after = output.output
      try {
        recorder?.record(before as string, after as string, (input as any).sessionID, truncated)
      } catch {}
    },
    dispose: async () => {
      try {
        recorder?.close()
      } catch {}
    },
  }
}) satisfies Plugin
