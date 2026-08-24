/**
 * Bounded recorder used by hook and store.
 * Never throws into hook; bounded 16 jobs / 8 MiB UTF-8 bytes;
 * O(1) length gate before Buffer.byteLength.
 * TUI must never import this (it imports worker/tokenizer).
 */

import { createWorker, type Job, FOUR_MIB, MAX_JOBS, MAX_BYTES } from "./worker"

export type RecorderCtx = {
  stateRoot: string
  projectKey: string
  projectDir: string
  identityKey?: Buffer | null
}

export type Recorder = {
  record(before: string, after: string, sessionId: string, truncated: boolean): void
  close(): void
  // testing seams
  _worker?: ReturnType<typeof createWorker>
  _getDroppedCount?(): number
}

export function createRecorder(ctx: RecorderCtx): Recorder {
  // validate ctx lightly, but never throw
  let worker: ReturnType<typeof createWorker> | null = null
  try {
    // basic validation: projectKey should be 64 hex, but we don't enforce strictly here to keep fail-open
    worker = createWorker(ctx)
  } catch {
    worker = null
  }

  let closed = false

  function record(before: string, after: string, sessionId: string, truncated: boolean): void {
    try {
      if (closed) return
      if (!worker) return
      if (typeof before !== "string" || typeof after !== "string" || typeof sessionId !== "string") return
      if (typeof truncated !== "boolean") truncated = !!truncated

      // ---- O(1) UTF-16 length gate before Buffer.byteLength ----
      // checked addition for length: before.length + after.length as JS number
      const combinedLen = before.length + after.length
      // overflow check not needed for JS string lengths but keep safe integer check
      if (!Number.isSafeInteger(combinedLen)) {
        // treat as oversize
        const job: Job = { kind: "oversize", sessionId, hostTruncatedAtEntry: truncated }
        worker.enqueue(job)
        return
      }
      if (combinedLen > FOUR_MIB) {
        // O(1) oversize: do not call Buffer.byteLength, do not retain strings
        const job: Job = { kind: "oversize", sessionId, hostTruncatedAtEntry: truncated }
        worker.enqueue(job)
        return
      }

      // ---- exact UTF-8 byteLength (scans at most 4MiB code units) ----
      let beforeBytes: number
      let afterBytes: number
      try {
        beforeBytes = Buffer.byteLength(before, "utf8")
        afterBytes = Buffer.byteLength(after, "utf8")
      } catch {
        // byteLength threw (should not), treat as oversize
        const job: Job = { kind: "oversize", sessionId, hostTruncatedAtEntry: truncated }
        worker.enqueue(job)
        return
      }
      const combinedBytes = beforeBytes + afterBytes
      if (!Number.isSafeInteger(combinedBytes) || combinedBytes > FOUR_MIB) {
        const job: Job = { kind: "oversize", sessionId, hostTruncatedAtEntry: truncated }
        worker.enqueue(job)
        return
      }

      // admitted normal job: includes both strings and exact byte count
      const job: Job = {
        kind: "measure",
        sessionId,
        hostTruncatedAtEntry: truncated,
        before,
        after,
        combinedUtf8Bytes: combinedBytes,
      }
      worker.enqueue(job)
    } catch {
      // never throw into hook
    }
  }

  function close(): void {
    try {
      closed = true
      if (worker) worker.close()
    } catch {}
  }

  const rec: Recorder = {
    record,
    close,
  }
  // expose worker for testing
  try {
    Object.defineProperty(rec, "_worker", { value: worker, enumerable: false })
    Object.defineProperty(rec, "_getDroppedCount", {
      value: () => {
        try {
          return (worker as any)?.getDroppedCount?.() ?? 0
        } catch {
          return 0
        }
      },
      enumerable: false,
    })
  } catch {}
  return rec
}
