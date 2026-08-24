/** Shared LSP protocol shapes for compact/format/plugin characterization tests. */

type RangeCoords = { sl: number; sc: number; el: number; ec: number }

function pos(line: number, character: number) {
  return { line, character }
}

function rng(sl: number, sc: number, el: number, ec: number) {
  return { start: pos(sl, sc), end: pos(el, ec) }
}

/** LSP Location. Line/character arguments are 0-based protocol values. */
export function location(uri: string, sl: number, sc: number, el: number, ec: number) {
  return { uri, range: rng(sl, sc, el, ec) }
}

/** LSP LocationLink. `sel` is targetSelectionRange; `target` is optional targetRange. */
export function locationLink(targetUri: string, sel: RangeCoords, target?: RangeCoords) {
  return {
    targetUri,
    ...(target ? { targetRange: rng(target.sl, target.sc, target.el, target.ec) } : {}),
    targetSelectionRange: rng(sel.sl, sel.sc, sel.el, sel.ec),
  }
}

/** SymbolKind 1–26 names, matching `src/compact.ts`. */
export const KIND_NAMES = [
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

const TOOL_URI = "file:///home/david/src/tool/lsp.ts"

/** Location[] as textDocument/definition returns without linkSupport. */
export const definitionLocations = [location(TOOL_URI, 36, 13, 36, 20)]

/** LocationLink[] as textDocument/definition returns with linkSupport. */
export const definitionLocationLinks = [{
  originSelectionRange: rng(246, 47, 246, 54),
  ...locationLink(TOOL_URI, { sl: 36, sc: 13, el: 36, ec: 20 }, { sl: 36, sc: 0, el: 111, ec: 1 }),
}]

/** Hover[] with MarkupContent. */
export const hoverMarkup = [{
  contents: { kind: "markdown", value: "const X: 1" },
  range: rng(0, 0, 0, 1),
}]

/** Multi-client hover result with an empty slot. */
export const hoverNullSlot = [null, hoverMarkup[0]]

/** workspace/symbol SymbolInformation (flat, with containerName). */
export const symbolInformation = {
  name: "LspTool",
  kind: 14,
  location: location(TOOL_URI, 36, 13, 36, 20),
  containerName: "lsp",
}

/** textDocument/documentSymbol as SymbolInformation[] when hierarchical support is off. */
export const flatDocumentSymbols = [
  {
    name: "LspTool",
    kind: 14,
    location: location(TOOL_URI, 36, 0, 111, 1),
  },
  {
    name: "execute",
    kind: 6,
    location: location(TOOL_URI, 45, 8, 110, 11),
    containerName: "LspTool",
  },
]

/** Hierarchical DocumentSymbol tree. */
export const documentSymbolTree = [{
  name: "LspTool",
  kind: 14,
  detail: "const",
  range: rng(36, 0, 111, 1),
  selectionRange: rng(36, 13, 36, 20),
  children: [{
    name: "execute",
    kind: 6,
    range: rng(45, 8, 110, 11),
    selectionRange: rng(45, 16, 45, 23),
  }],
}]

/** CallHierarchyItem (uri + selectionRange, not a Location). */
export const callHierarchyItem = {
  name: "execute",
  kind: 6,
  uri: TOOL_URI,
  range: rng(45, 8, 110, 11),
  selectionRange: rng(45, 16, 45, 23),
}

export const incomingCall = {
  from: callHierarchyItem,
  fromRanges: [rng(246, 47, 246, 54)],
}

export const outgoingCall = {
  to: callHierarchyItem,
  fromRanges: [rng(246, 47, 246, 54)],
}
