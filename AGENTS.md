# Agent notes

OpenCode server + TUI plugin. Server hooks `tool.execute.after` on builtin `lsp` and rewrites `output` (not `metadata`). TUI export is a no-op so the plugin appears in the TUI plugin list. Do **not** register `tool: { lsp }`.

## Local development

Point config at this **package directory** (so TUI can load `exports["./tui"]`). Do not point at `src/plugin.ts`.

In this repo:

```json
{
  "plugin": [[".", { "compact": true, "minified": true }]]
}
```

From another repo:

```json
{
  "plugin": [["../opencode-compact-lsp", { "compact": true, "minified": true }]]
}
```

Also register the same path in `tui.json` as a string spec, or run:

```
bun src/cli.ts install --project
```

`install` / `doctor --fix` write a tuple into `opencode.json` and a string spec into `tui.json`. Spec is unpinned for a PATH binary, `name@version` for npx/bunx, and `name@latest` / `name@next` from those paths.

## Commands

```
bun test
bun run build
bash scripts/qa-cli.sh
bash tests/e2e/smoke.sh
```

Smoke uses an isolated HOME and only checks plugin load (does not invoke `lsp`).

Builtin `lsp` is behind `OPENCODE_EXPERIMENTAL_LSP_TOOL`. Without it the hook is a silent no-op.

## Layout

| File | Role |
|------|------|
| `src/plugin.ts` | `tool.execute.after` hook |
| `src/tui.ts` | TUI module (`id` + empty `tui`) |
| `src/compact.ts` | Protocol JSON → DTO |
| `src/format.ts` | `applyLspOutput` flags + stringify |
| `src/cli.ts` | `install` / `doctor` |

Omit `compact` / `minified` → `true`. Both false is identity.

## Releases

Version comes from `package.json`, not from the git tag. Tag must be `v$version` (`next`) or `v$version-release` (`latest`). Workflow: `.github/workflows/publish.yml` → `scripts/npm-release.sh`. Token: `secrets.NPM_TOKEN` or `vars.NPM_TOKEN`. Do not `npm publish` from a developer machine except the first bootstrap.
