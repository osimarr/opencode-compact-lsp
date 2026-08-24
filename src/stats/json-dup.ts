/**
 * Duplicate-aware JSON tokenization, safe for TUI.
 * No Node fs/crypto/lock imports. Pure string parsing only.
 */

export type Token =
  | { type: "{"; raw: string }
  | { type: "}"; raw: string }
  | { type: "["; raw: string }
  | { type: "]"; raw: string }
  | { type: ":"; raw: string }
  | { type: ","; raw: string }
  | { type: "string"; value: string; raw: string }
  | { type: "number"; value: string; raw: string }
  | { type: "literal"; value: string; raw: string }

export function tokenize(json: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = json.length
  while (i < n) {
    const c = json[i]
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i++
      continue
    }
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === ":" || c === ",") {
      tokens.push({ type: c as any, raw: c } as Token)
      i++
      continue
    }
    if (c === '"') {
      const start = i
      i++
      while (i < n) {
        if (json[i] === "\\") {
          i += 2
          continue
        }
        if (json[i] === '"') {
          i++
          break
        }
        i++
      }
      const raw = json.slice(start, i)
      let decoded: string
      try {
        decoded = JSON.parse(raw)
      } catch {
        throw new Error("Invalid string token")
      }
      tokens.push({ type: "string", value: decoded, raw })
      continue
    }
    if (c === "t") {
      if (json.startsWith("true", i)) {
        tokens.push({ type: "literal", value: "true", raw: "true" })
        i += 4
        continue
      }
      throw new Error("Invalid literal")
    }
    if (c === "f") {
      if (json.startsWith("false", i)) {
        tokens.push({ type: "literal", value: "false", raw: "false" })
        i += 5
        continue
      }
      throw new Error("Invalid literal")
    }
    if (c === "n") {
      if (json.startsWith("null", i)) {
        tokens.push({ type: "literal", value: "null", raw: "null" })
        i += 4
        continue
      }
      throw new Error("Invalid literal")
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const start = i
      i++
      while (i < n && /[0-9eE.\+\-]/.test(json[i]!)) i++
      const raw = json.slice(start, i)
      tokens.push({ type: "number", value: raw, raw })
      continue
    }
    throw new Error(`Unexpected char ${c} at ${i}`)
  }
  return tokens
}

export function hasDuplicateKeys(json: string): boolean {
  const tokens = tokenize(json)
  type ObjectFrame = { type: "object"; keys: Set<string>; expect: "keyOrEnd" | "value" | "commaOrEnd" | "key" }
  type ArrayFrame = { type: "array"; expect: "valueOrEnd" | "value" | "commaOrEnd" }
  type Frame = ObjectFrame | ArrayFrame
  const stack: Frame[] = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i] as Token
    if (stack.length === 0) {
      if (tok.type === "{") {
        stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
        i++
        continue
      }
      if (tok.type === "[") {
        stack.push({ type: "array", expect: "valueOrEnd" })
        i++
        continue
      }
      if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
        i++
        continue
      }
      i++
      continue
    }
    const top = stack[stack.length - 1]!
    if (top.type === "object") {
      if (top.expect === "keyOrEnd") {
        if (tok.type === "}") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else if (tok.type === "string") {
          const next = tokens[i + 1] as Token | undefined
          if (next && next.type === ":") {
            const key = (tok as { type: "string"; value: string }).value
            if (top.keys.has(key)) return true
            top.keys.add(key)
            top.expect = "value"
            i += 2
            continue
          } else {
            i++
            continue
          }
        } else {
          i++
          continue
        }
      } else if (top.expect === "value") {
        if (tok.type === "{") {
          stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
          i++
          continue
        } else if (tok.type === "[") {
          stack.push({ type: "array", expect: "valueOrEnd" })
          i++
          continue
        } else if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
          top.expect = "commaOrEnd"
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "commaOrEnd") {
        if (tok.type === ",") {
          top.expect = "key"
          i++
          continue
        } else if (tok.type === "}") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "key") {
        if (tok.type === "string") {
          const next = tokens[i + 1] as Token | undefined
          if (next && next.type === ":") {
            const key = (tok as { type: "string"; value: string }).value
            if (top.keys.has(key)) return true
            top.keys.add(key)
            top.expect = "value"
            i += 2
            continue
          } else {
            i++
            continue
          }
        } else {
          i++
          continue
        }
      } else {
        i++
        continue
      }
    } else {
      if (top.expect === "valueOrEnd") {
        if (tok.type === "]") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else if (tok.type === "{") {
          stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
          i++
          continue
        } else if (tok.type === "[") {
          stack.push({ type: "array", expect: "valueOrEnd" })
          i++
          continue
        } else if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
          top.expect = "commaOrEnd"
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "value") {
        if (tok.type === "{") {
          stack.push({ type: "object", keys: new Set(), expect: "keyOrEnd" })
          i++
          continue
        } else if (tok.type === "[") {
          stack.push({ type: "array", expect: "valueOrEnd" })
          i++
          continue
        } else if (tok.type === "string" || tok.type === "number" || tok.type === "literal") {
          top.expect = "commaOrEnd"
          i++
          continue
        } else {
          i++
          continue
        }
      } else if (top.expect === "commaOrEnd") {
        if (tok.type === ",") {
          top.expect = "value"
          i++
          continue
        } else if (tok.type === "]") {
          stack.pop()
          if (stack.length > 0) {
            const parent = stack[stack.length - 1]!
            if (parent.type === "object" && parent.expect === "value") parent.expect = "commaOrEnd"
            else if (parent.type === "array" && (parent.expect === "value" || parent.expect === "valueOrEnd")) parent.expect = "commaOrEnd"
          }
          i++
          continue
        } else {
          i++
          continue
        }
      } else {
        i++
        continue
      }
    }
  }
  return false
}
