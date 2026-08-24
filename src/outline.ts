type SymbolNode = {
  name: unknown
  kind: unknown
  line: unknown
  column?: unknown
  path?: unknown
  children?: unknown
}

export function isSymbolForest(value: unknown): boolean {
  if (isSymbolNode(value)) return true
  return Array.isArray(value) && value.length > 0 && value.every(isSymbolNode)
}

export function formatSymbolOutline(value: unknown): string {
  if (Array.isArray(value)) return value.map((node) => formatNode(node, 0)).join("\n")
  return formatNode(value, 0)
}

function isSymbolNode(value: unknown): value is SymbolNode {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return "name" in obj && "kind" in obj && "line" in obj
}

function formatNode(value: unknown, depth: number): string {
  const obj = value as SymbolNode
  const name = String(obj.name).replaceAll("\n", " ")
  const indent = "  ".repeat(depth)
  const path = typeof obj.path === "string" ? ` ${obj.path}` : ""
  const line = `${indent}${obj.line}:${obj.column} ${obj.kind} ${name}${path}`
  if (!Array.isArray(obj.children) || obj.children.length === 0) return line
  return [line, ...obj.children.map((child) => formatNode(child, depth + 1))].join("\n")
}
