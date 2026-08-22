const KIND_NAMES = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
] as const

type LspPosition = { line: number; character: number }
type LspRange = { start: LspPosition; end: LspPosition }

export function compactValue(value: unknown): unknown {
  if (value == null) return null
  if (Array.isArray(value)) return dedup(value.map(compactValue).filter((item) => item != null))
  if (typeof value !== "object") return value

  const obj = value as Record<string, unknown>
  if (typeof obj.targetUri === "string") {
    const range = asRange(obj.targetSelectionRange) ?? asRange(obj.targetRange)
    if (range) return compactLocation(obj.targetUri, range)
  }
  if ("contents" in obj) return { contents: hoverText(obj.contents) }

  const symbol = compactSymbol(obj)
  if (symbol) return symbol

  if (typeof obj.uri === "string") {
    const range = asRange(obj.range)
    if (range) return compactLocation(obj.uri, range)
  }
  if ("from" in obj) return compactValue(obj.from)
  if ("to" in obj) return compactValue(obj.to)

  const mapped: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(obj)) {
    const compacted = compactValue(nested)
    if (compacted != null) mapped[key] = compacted
  }
  return mapped
}

function kindName(kind: unknown): string {
  if (typeof kind === "number" && Number.isInteger(kind) && kind >= 1 && kind <= 26) {
    return KIND_NAMES[kind - 1]
  }
  return String(kind)
}

function filePath(uri: string): string {
  const raw = uri.startsWith("file://") ? uri.slice("file://".length) : uri
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function isPosition(value: unknown): value is LspPosition {
  if (value == null || typeof value !== "object") return false
  const pos = value as Record<string, unknown>
  return typeof pos.line === "number" && typeof pos.character === "number"
}

function asRange(value: unknown): LspRange | undefined {
  if (value == null || typeof value !== "object") return undefined
  const range = value as Record<string, unknown>
  if (!isPosition(range.start) || !isPosition(range.end)) return undefined
  return { start: range.start, end: range.end }
}

function compactLocation(uri: string, range: LspRange) {
  return {
    path: filePath(uri),
    line: range.start.line + 1,
    column: range.start.character + 1,
    end_line: range.end.line + 1,
    end_column: range.end.character + 1,
  }
}

function hoverText(contents: unknown): string {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) return contents.map(hoverText).join("\n\n")
  if (contents != null && typeof contents === "object" && "value" in contents) {
    const value = (contents as { value: unknown }).value
    if (typeof value === "string") return value
  }
  return String(contents)
}

function compactSymbol(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!("name" in obj) || !("kind" in obj)) return undefined
  const location = asLocation(obj.location)
  const range = asRange(obj.selectionRange) ?? asRange(obj.range) ?? location?.range
  if (!range) return undefined

  const out: Record<string, unknown> = {
    name: obj.name,
    kind: kindName(obj.kind),
  }
  const uri = location?.uri ?? (typeof obj.uri === "string" ? obj.uri : undefined)
  if (uri) out.path = filePath(uri)
  out.line = range.start.line + 1
  out.column = range.start.character + 1

  if (Array.isArray(obj.children) && obj.children.length > 0) {
    const children = compactValue(obj.children)
    if (Array.isArray(children) && children.length > 0) out.children = children
  }
  return out
}

function asLocation(value: unknown): { uri: string; range: LspRange } | undefined {
  if (value == null || typeof value !== "object") return undefined
  const loc = value as Record<string, unknown>
  const range = asRange(loc.range)
  if (typeof loc.uri !== "string" || !range) return undefined
  return { uri: loc.uri, range }
}

function dedup(items: unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const item of items) {
    const key = dedupKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function dedupKey(item: unknown): string {
  if (item != null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>
    if ("path" in obj || "line" in obj) {
      return `${obj.path}:${obj.line}:${obj.column}:${obj.name ?? ""}`
    }
  }
  return JSON.stringify(item)
}
