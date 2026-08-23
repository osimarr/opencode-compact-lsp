# opencode-compact-lsp

OpenCode server plugin that rewrites builtin `lsp` tool JSON: compact it to a Codex-style DTO and/or minify it. It does **not** replace the `lsp` tool; it hooks `tool.execute.after`.

Builtin `lsp` is behind `OPENCODE_EXPERIMENTAL_LSP_TOOL`. Without that flag the tool never runs, so this plugin is a silent no-op.

## Flags

Omitted `compact` / `minified` default to `true`. Only explicit `false` disables a flag. Both false is identity (the original protocol JSON).

| compact | minified | Result |
|---------|----------|--------|
| `false` | `false` | Identity (protocol JSON unchanged) |
| `false` | `true`  | Minify protocol JSON |
| `true`  | `false` | Pretty-printed Codex DTO |
| `true`  | `true`  | Minified Codex DTO (default) |

## Install

```
npx opencode-compact-lsp install
```

Then quit and restart OpenCode.

`install` writes a plugin tuple into `opencode.json` (or `opencode.jsonc`). It does not touch `tui.json`.

```
npx opencode-compact-lsp install --global
npx opencode-compact-lsp install --project
npx opencode-compact-lsp install --compact --minified
npx opencode-compact-lsp install --no-compact --no-minified
```

| Flag | Effect |
|------|--------|
| `--global` | `~/.config/opencode/opencode.json` |
| `--project` | `.opencode/opencode.json` |
| `--compact` / `--no-compact` | Codex DTO on / off |
| `--minified` / `--no-minified` | Minify JSON on / off |

Replace `npx` with `bunx`, or use `opencode-compact-lsp` if the binary is on PATH.

## Doctor

```
npx opencode-compact-lsp doctor
npx opencode-compact-lsp doctor --fix
npx opencode-compact-lsp doctor --clear
```

- `doctor` — OpenCode version, opencode.json parse, plugin registration
- `doctor --fix` — register the plugin if missing
- `doctor --clear` — delete `~/.cache/opencode/packages/opencode-compact-lsp@*`

`--fix` accepts the same `--global` / `--project` and compact/minified flags as `install`.

## Local development

Point project `.opencode/opencode.json` at the source plugin:

```json
{
  "plugin": [["../opencode-compact-lsp/src/plugin.ts", { "compact": true, "minified": true }]]
}
```

Or run the CLI from source:

```
bun src/cli.ts install --project
```

Load-smoke (isolated HOME, plugin load only — does not invoke `lsp`):

```
bash tests/e2e/smoke.sh
```
