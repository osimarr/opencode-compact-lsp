/**
 * Lazy singleton tokenizer for o200k_base (gpt-tokenizer@4.0.0).
 * Only server worker imports this; TUI must never import it.
 */

type Tokenizer = {
  encode(text: string): number[]
}

let cached: Tokenizer | null = null
let loading: Promise<Tokenizer> | null = null

export async function getTokenizer(): Promise<Tokenizer> {
  if (cached) return cached
  if (loading) return loading
  loading = (async () => {
    // Explicit entry per ADR - use variable spec to avoid TS resolution when dep not yet installed (Task 8 adds it)
    const spec = "gpt-tokenizer/encoding/o200k_base"
    const mod: any = await import(spec)
    const candidate = mod?.default ?? mod
    // gpt-tokenizer exposes encode directly or via object
    if (candidate && typeof candidate.encode === "function") {
      cached = candidate as Tokenizer
      return cached
    }
    if (typeof candidate === "function") {
      // some versions export encode as function itself
      cached = { encode: candidate as (s: string) => number[] }
      return cached
    }
    // Fallback: try named import
    if (mod?.encode && typeof mod.encode === "function") {
      cached = { encode: mod.encode as (s: string) => number[] }
      return cached
    }
    throw new Error("gpt-tokenizer o200k_base encode not found")
  })()
  // On failure, clear loading so retry can happen (will be counted as tokenizerError)
  try {
    const t = await loading
    return t
  } catch (e) {
    loading = null
    throw e
  }
}

export async function countTokens(text: string): Promise<number> {
  const tok = await getTokenizer()
  const arr = tok.encode(text)
  if (!Array.isArray(arr)) throw new Error("tokenizer returned non-array")
  // validate safe integer length
  const n = arr.length
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid token count")
  return n
}

// Test seams: allow injecting mock tokenizer without importing gpt-tokenizer
export function __setTokenizerForTest(mock: Tokenizer | null): void {
  cached = mock
  loading = mock ? Promise.resolve(mock) : null
}

export function __resetTokenizerForTest(): void {
  cached = null
  loading = null
}
