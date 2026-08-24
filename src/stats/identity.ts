import { createHmac } from "node:crypto"
import * as path from "node:path"
import { realpath } from "node:fs/promises"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCb)

/**
 * Derive opaque project key from 32-byte identity key and canonical project identity.
 * Message: ASCII("project-v1") || 0x00 || UTF8(canonical)
 */
export function deriveProjectKey(key32: Buffer, canonical: string): string {
  return createHmac("sha256", key32)
    .update(Buffer.concat([Buffer.from("project-v1"), Buffer.from([0]), Buffer.from(canonical, "utf8")]))
    .digest("hex")
}

/**
 * Derive opaque session key from 32-byte identity key, hex project key and session ID.
 * Message: ASCII("session-v1") || 0x00 || ASCII(projectKey) || 0x00 || UTF8(sessionId)
 */
export function deriveSessionKey(key32: Buffer, projectKeyHex: string, sessionId: string): string {
  return createHmac("sha256", key32)
    .update(
      Buffer.concat([
        Buffer.from("session-v1"),
        Buffer.from([0]),
        Buffer.from(projectKeyHex, "ascii"),
        Buffer.from([0]),
        Buffer.from(sessionId, "utf8"),
      ]),
    )
    .digest("hex")
}

/**
 * Resolve state root per ADR.
 * - If XDG_STATE_HOME is set to a nonempty absolute path, use <XDG_STATE_HOME>/opencode/opencode-compact-lsp
 * - A set but non-absolute XDG_STATE_HOME makes statistics unavailable (throws)
 * - If unset on Linux/macOS, use ~/.local/state/opencode/opencode-compact-lsp
 * - If unset on Windows, use %LOCALAPPDATA%/opencode/opencode-compact-lsp
 * - If required home or LOCALAPPDATA cannot be resolved, throws (unavailable)
 */
export function resolveStateRoot(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_STATE_HOME
  // nonempty absolute -> use it
  if (typeof xdg === "string" && xdg.length > 0) {
    if (!path.isAbsolute(xdg)) {
      throw new Error("XDG_STATE_HOME is not absolute")
    }
    return path.join(xdg, "opencode", "opencode-compact-lsp")
  }
  // xdg is undefined or empty string => fallback per platform
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA
    if (typeof local !== "string" || local.length === 0) {
      throw new Error("LOCALAPPDATA is not set")
    }
    if (!path.isAbsolute(local)) {
      throw new Error("LOCALAPPDATA is not absolute")
    }
    return path.join(local, "opencode", "opencode-compact-lsp")
  } else {
    const home = env.HOME
    if (typeof home !== "string" || home.length === 0) {
      throw new Error("HOME is not set")
    }
    return path.join(home, ".local", "state", "opencode", "opencode-compact-lsp")
  }
}

/**
 * Canonical project identity.
 * Runs git rev-parse with absolute path-format fallback, then realpath, path.normalize,
 * and strips trailing platform separators except when normalized equals its filesystem root.
 */
export async function canonicalProjectIdentity(directory: string): Promise<string> {
  let resolvedForRealpath: string | null = null

  // Try absolute git form first
  try {
    const { stdout } = (await execFile("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    } as any)) as unknown as { stdout: string }
    const out = stdout.trim()
    if (out.length > 0) {
      resolvedForRealpath = out
    } else {
      throw new Error("empty git output")
    }
  } catch {
    // Fallback form
    try {
      const { stdout } = (await execFile("git", ["-C", directory, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
      } as any)) as unknown as { stdout: string }
      const out = stdout.trim()
      if (out.length === 0) throw new Error("empty git output")
      if (path.isAbsolute(out)) {
        resolvedForRealpath = out
      } else {
        resolvedForRealpath = path.resolve(directory, out)
      }
    } catch {
      resolvedForRealpath = null
    }
  }

  let real: string
  if (resolvedForRealpath !== null) {
    try {
      real = await realpath(resolvedForRealpath)
    } catch {
      // If git-derived path cannotbe realpathed, fall back to directory realpath
      real = await realpath(directory)
    }
  } else {
    real = await realpath(directory)
  }

  let normalized = path.normalize(real)
  const root = path.parse(normalized).root
  if (normalized.length > root.length) {
    // Strip trailing platform separators
    while (normalized.length > root.length && normalized.endsWith(path.sep)) {
      normalized = normalized.slice(0, -path.sep.length)
    }
    // Also handle case where input used opposite separator on Windows? Strip both to be safe
    // But spec says only platform separators, so we keep strict.
  }
  return normalized
}
