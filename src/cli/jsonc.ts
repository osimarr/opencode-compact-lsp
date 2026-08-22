import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json"

export type JsoncFormat = "json" | "jsonc" | "none"

export function detectJsoncFile(configDir: string, baseName: string): { path: string; format: JsoncFormat } {
  const jsoncPath = `${configDir}/${baseName}.jsonc`
  const jsonPath = `${configDir}/${baseName}.json`
  if (existsSync(jsoncPath)) return { path: jsoncPath, format: "jsonc" }
  if (existsSync(jsonPath)) return { path: jsonPath, format: "json" }
  return { path: jsonPath, format: "none" }
}

export function readJsoncFile(path: string): { value: Record<string, unknown> | null; error?: string } {
  if (!existsSync(path)) return { value: null }
  try {
    const value = parseJsonc(readFileSync(path, "utf-8")) as Record<string, unknown>
    return { value }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export function writeJsoncFile(path: string, value: Record<string, unknown>, format: JsoncFormat = "json"): void {
  mkdirSync(dirname(path), { recursive: true })
  const serialized = format === "jsonc" ? stringifyJsonc(value, null, 2) : JSON.stringify(value, null, 2)
  writeFileSync(path, `${serialized}\n`)
}
