import type { Plugin } from "@opencode-ai/plugin"
import { resolveOptions } from "./options"
import { applyLspOutput } from "./format"
import { createRecorder as defaultCreateRecorder } from "./stats/recorder"
import type { Recorder } from "./stats/recorder"
import * as path from "node:path"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import { canonicalProjectIdentity, deriveProjectKey, resolveStateRoot } from "./stats/identity"

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
      let ctx: { stateRoot: string; projectKey: string; projectDir: string } | null = null
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
          let key32: Buffer
          try {
            const data = await fs.readFile(path.join(stateRoot, "identity-v1"))
            if (data.length === 32) key32 = Buffer.from(data)
            else throw new Error("invalid identity length")
          } catch {
            // ephemeral for Task 5; Task 6 will persist with locking
            key32 = crypto.randomBytes(32)
          }
          const projectKey = deriveProjectKey(key32, canonical)
          const projectDir = path.join(stateRoot, "projects", projectKey)
          ctx = { stateRoot, projectKey, projectDir }
        } else {
          // test-only dummy ctx when factory is injected but no directory (e.g., {} as input)
          const stateRoot = path.join("/tmp", "opencode-compact-lsp-test")
          const projectKey = "a".repeat(64)
          const projectDir = path.join(stateRoot, "projects", projectKey)
          ctx = { stateRoot, projectKey, projectDir }
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
