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
  const nodes = Array.isArray(value) ? value : [value]
  const omitPath = shouldOmitPath(nodes)
  if (Array.isArray(value)) return value.map((node) => formatNode(node, 0, omitPath)).join("\n")
  return formatNode(value, 0, omitPath)
}

function countSymbols(nodes: unknown[]): number {
  let count = 0
  for (const node of nodes) {
    if (!isSymbolNode(node)) continue
    count += 1
    if (Array.isArray(node.children)) count += countSymbols(node.children)
  }
  return count
}

function collectPaths(nodes: unknown[], paths: Set<string>) {
  for (const node of nodes) {
    if (!isSymbolNode(node)) continue
    if (typeof node.path === "string") paths.add(node.path)
    if (Array.isArray(node.children)) collectPaths(node.children, paths)
  }
}

function shouldOmitPath(nodes: unknown[]): boolean {
  if (countSymbols(nodes) < 2) return false
  const paths = new Set<string>()
  collectPaths(nodes, paths)
  return paths.size <= 1
}

function isSymbolNode(value: unknown): value is SymbolNode {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  return "name" in obj && "kind" in obj && "line" in obj
}

function formatNode(value: unknown, depth: number, omitPath: boolean): string {
  const obj = value as SymbolNode
  const name = String(obj.name).replaceAll("\n", " ")
  const indent = "  ".repeat(depth)
  const path = !omitPath && typeof obj.path === "string" ? ` ${obj.path}` : ""
  const line = `${indent}${obj.line}:${obj.column} ${obj.kind} ${name}${path}`
  if (!Array.isArray(obj.children) || obj.children.length === 0) return line
  return [line, ...obj.children.map((child) => formatNode(child, depth + 1, omitPath))].join("\n")
}
