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
  if (Array.isArray(value)) {
    const nested = nestSymbolInformation(value)
    return dedup(nested.map(compactValue).filter((item: unknown) => item != null))
  }
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

type SymbolNode = Record<string, unknown> & { children: unknown[] }

function isFlatSymbolInformation(item: unknown): item is Record<string, unknown> {
  if (item == null || typeof item !== "object" || Array.isArray(item)) return false
  const obj = item as Record<string, unknown>
  if (!("name" in obj) || !("kind" in obj)) return false
  if (Array.isArray(obj.children) && obj.children.length > 0) return false
  return asLocation(obj.location) != null
}

function nestSymbolInformation(items: unknown[]): unknown[] {
  if (items.length === 0 || !items.every(isFlatSymbolInformation)) return items
  if (!items.some((item) => typeof item.containerName === "string" && item.containerName.length > 0)) return items

  const nodes: SymbolNode[] = items.map((item) => ({ ...item, children: [] }))
  const roots: SymbolNode[] = []
  for (const node of nodes) {
    const parent = findContainer(nodes, node)
    if (parent && !isDescendant(node, parent)) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function symbolUri(obj: Record<string, unknown>): string | undefined {
  return asLocation(obj.location)?.uri
}

function symbolRange(obj: Record<string, unknown>): LspRange | undefined {
  return asLocation(obj.location)?.range
}

function rangeContains(outer: LspRange, inner: LspRange): boolean {
  const startsBefore =
    outer.start.line < inner.start.line
    || (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)
  const endsAfter =
    outer.end.line > inner.end.line
    || (outer.end.line === inner.end.line && outer.end.character >= inner.end.character)
  return startsBefore && endsAfter
}

function rangeSize(range: LspRange): number {
  return (range.end.line - range.start.line) * 1e6 + (range.end.character - range.start.character)
}

function findContainer(nodes: SymbolNode[], node: SymbolNode): SymbolNode | undefined {
  const name = node.containerName
  if (typeof name !== "string" || name.length === 0) return undefined
  const uri = symbolUri(node)
  const range = symbolRange(node)
  const candidates = nodes.filter((parent) => parent !== node && parent.name === name && symbolUri(parent) === uri)
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  if (!range) return candidates[0]
  const containing = candidates.filter((parent) => {
    const parentRange = symbolRange(parent)
    return parentRange ? rangeContains(parentRange, range) : false
  })
  if (containing.length === 0) {
    const preceding = candidates.filter((parent) => {
      const parentRange = symbolRange(parent)
      if (!parentRange) return false
      return (
        parentRange.start.line < range.start.line
        || (parentRange.start.line === range.start.line && parentRange.start.character <= range.start.character)
      )
    })
    return preceding.at(-1) ?? candidates[0]
  }
  return containing.reduce((best, parent) => {
    const bestRange = symbolRange(best)
    const parentRange = symbolRange(parent)
    if (!bestRange || !parentRange) return best
    return rangeSize(parentRange) < rangeSize(bestRange) ? parent : best
  })
}

function isDescendant(ancestor: SymbolNode, node: unknown): boolean {
  const stack = [...ancestor.children]
  while (stack.length) {
    const current = stack.pop()
    if (current === node) return true
    if (current != null && typeof current === "object" && "children" in current) {
      const children = (current as { children: unknown }).children
      if (Array.isArray(children)) stack.push(...children)
    }
  }
  return false
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
