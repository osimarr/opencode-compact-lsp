# opencode-compact-lsp

OpenCode server plugin that rewrites builtin `lsp` tool JSON: compact it to a Codex-style DTO and/or minify it. It does **not** replace the `lsp` tool; it hooks `tool.execute.after`.

Builtin `lsp` is behind `OPENCODE_EXPERIMENTAL_LSP_TOOL`. Without that flag the tool never runs, so this plugin is a silent no-op.

## Protocol JSON

The Language Server Protocol is JSON-RPC. Each reply is a **protocol object**: `file://` URIs, nested `range` / `selectionRange` (`start.line` / `character`, 0-based), numeric `kind`, and hover `MarkupContent { kind, value }`. A `LocationLink` carries three ranges.

OpenCode’s builtin `lsp` tool `JSON.stringify`s those objects with indent 2 and sends that string to the model. That is **protocol JSON** — the wire format, not a summary. It is large because every symbol repeats the same keys and pretty-print whitespace, and because OpenCode fans out to every matching server and concatenates.

This plugin leaves the language server alone. It rewrites the tool **output** after OpenCode has the protocol payload: either minify that JSON, project it to a smaller DTO (`path`, 1-based `line` / `column`, kind names), or both.

## Flags

Omitted `compact` / `minified` default to `true`. Only explicit `false` disables a flag.

| compact | minified | Result |
|---------|----------|--------|
| `false` | `false` | Protocol JSON, pretty (OpenCode default; identity) |
| `false` | `true`  | Protocol JSON, minified |
| `true`  | `false` | DTO, pretty |
| `true`  | `true`  | DTO, minified (plugin default) |

## Token savings

Live **typescript-language-server 5.3.0** payloads, **o200k** tokens. Columns are the four flag pairs above. Shrink is DTO mini vs protocol pretty.

| Call | Protocol pretty | Protocol mini | DTO pretty | DTO mini | vs protocol pretty |
|------|----------------:|--------------:|-----------:|---------:|--------------------|
| `compact.ts` documentSymbol | 5461 | 3073 | 2833 | 1897 | **2.9×** (65%) |
| `compact.ts` hover | 87 | 51 | 24 | 21 | **4.1×** |
| `compact.ts` definition | 79 | 46 | 58 | 40 | **2.0×** |
| `compact.ts` references | 464 | 266 | 338 | 230 | **2.0×** |
| `compact.ts` workspaceSymbol | 101 | 58 | 57 | 39 | **2.6×** |
| `config.ts` documentSymbol | 29835 | 16993 | 15028 | 10030 | **3.0×** (66%) |
| `lsp.ts` documentSymbol | 5257 | 2967 | 2661 | 1779 | **3.0×** |
| `lsp.ts` hover | 85 | 49 | 22 | 19 | **4.5×** |

Minify-only is ~1.7× on symbol trees (whitespace). The DTO is the rest: drop extra ranges, `file://`, kind ints, `selectionRange`. Default (DTO mini) turns a large `documentSymbol` from ~30k tokens into ~10k. Hover wrappers shrink ~4×; the markdown type blob still dominates hover.

## Examples

Same `goToDefinition` hit under each flag pair. OpenCode without this plugin is the first column.

**Protocol pretty** (`compact: false`, `minified: false`):

```json
[
  {
    "originSelectionRange": {
      "start": { "line": 246, "character": 47 },
      "end": { "line": 246, "character": 54 }
    },
    "targetUri": "file:///home/david/projects/opencode/opencode/packages/opencode/src/tool/lsp.ts",
    "targetRange": {
      "start": { "line": 36, "character": 0 },
      "end": { "line": 111, "character": 1 }
    },
    "targetSelectionRange": {
      "start": { "line": 36, "character": 13 },
      "end": { "line": 36, "character": 20 }
    }
  }
]
```

**Protocol mini** (`compact: false`, `minified: true`): same object, one line, no indent.

**DTO pretty** (`compact: true`, `minified: false`):

```json
[
  {
    "path": "/home/david/projects/opencode/opencode/packages/opencode/src/tool/lsp.ts",
    "line": 37,
    "column": 14,
    "end_line": 37,
    "end_column": 21
  }
]
```

**DTO mini** (`compact: true`, `minified: true`, plugin default):

```json
[{"path":"/home/david/projects/opencode/opencode/packages/opencode/src/tool/lsp.ts","line":37,"column":14,"end_line":37,"end_column":21}]
```

`documentSymbol` drops `selectionRange` / `detail` and names the kind:

```json
{
  "name": "LspTool",
  "kind": 14,
  "detail": "const",
  "range": { "start": { "line": 36, "character": 0 }, "end": { "line": 111, "character": 1 } },
  "selectionRange": { "start": { "line": 36, "character": 13 }, "end": { "line": 36, "character": 20 } }
}
```

```json
{"name":"LspTool","kind":"Constant","line":37,"column":14}
```

Hover unwraps `MarkupContent` and drops `range`:

```json
[{ "contents": { "kind": "markdown", "value": "const LspTool: Tool.Info<...>" }, "range": { "start": { "line": 36, "character": 13 }, "end": { "line": 36, "character": 20 } } }]
```

```json
[{"contents":"const LspTool: Tool.Info<...>"}]
```

## Install

```
npx opencode-compact-lsp install
```

Then quit and restart OpenCode.

`install` writes a plugin tuple into `opencode.json` (server) and the same spec string into `tui.json` (TUI plugin list). Spec is unpinned for a PATH binary, `name@version` for npx/bunx, and `name@latest` / `name@next` when invoked from those paths.

```
npx opencode-compact-lsp install --global
npx opencode-compact-lsp install --project
npx opencode-compact-lsp install --compact --minified
npx opencode-compact-lsp install --no-compact --no-minified
```

| Flag | Effect |
|------|--------|
| `--global` | `~/.config/opencode/opencode.json` and `tui.json` |
| `--project` | `.opencode/opencode.json` and `tui.json` |
| `--compact` / `--no-compact` | Codex DTO on / off |
| `--minified` / `--no-minified` | Minify JSON on / off |

Replace `npx` with `bunx`, or use `opencode-compact-lsp` if the binary is on PATH.

## Doctor

```
npx opencode-compact-lsp doctor
npx opencode-compact-lsp doctor --fix
npx opencode-compact-lsp doctor --clear
```

- `doctor` — OpenCode version, opencode.json + tui.json registration
- `doctor --fix` — register the plugin in both files if missing
- `doctor --clear` — delete `~/.cache/opencode/packages/opencode-compact-lsp@*`

`--fix` accepts the same `--global` / `--project` and compact/minified flags as `install`.

## Releases

npm version is always `package.json`'s `version`. Git tags only choose the dist-tag:

| Git tag | npm dist-tag |
|---------|--------------|
| `v0.1.0` | `next` |
| `v0.1.0-release` | `latest` (promotes that version if it is already on the registry) |

Add `NPM_TOKEN` as a GitHub Actions secret (or repository variable). Then:

```
git tag v0.1.0
git push origin v0.1.0
```
