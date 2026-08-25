# Agent notes

OpenCode server + TUI plugin. Server hooks `tool.execute.after` on builtin `lsp` and rewrites `output` (not `metadata`). `exports["./tui"]` is `src/entry.mjs`, which loads the Solid-compiled graph under `dist/` (OpenTUI does not transform JSX in `node_modules`). Do **not** register `tool: { lsp }`.

## Local development

Point **server** config at this **package directory** (so `exports["."]` / `./server` load `src/plugin.ts`). Do not point at `src/plugin.ts` directly.

For a live TUI sidebar from source, point `tui.json` at `src/tui.ts` (file plugin, id `opencode-compact-lsp-dev`). Pointing at the package directory uses the compiled `./tui` export (id `opencode-compact-lsp`); run `bun run build` after TUI edits.

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

`install` / `doctor --fix` write a spec string into `opencode.json` and `tui.json` (implicit compact/minified true). Spec is unpinned for a PATH binary, `name@version` for npx/bunx, and `name@latest` / `name@next` from those paths.

## Commands

```
bun test
bun run build
bash scripts/qa-cli.sh
bash tests/e2e/smoke.sh
```

CI (`.github/workflows/qa.yml`) runs `bun test`, `bash scripts/qa-cli.sh`, and `bash tests/e2e/smoke.sh` on pull requests to `master` and pushes to `master`. Tag publish stays on `v*` tags whose commit is an ancestor of `origin/master`.

Smoke uses an isolated HOME and only checks plugin load (does not invoke `lsp`).
`bun test tests/qa` runs against a captured tsserver `documentSymbol` payload (flat `SymbolInformation[]`, OpenCode does not advertise hierarchical symbols). Flattened outlines fail that gate.

Builtin `lsp` is behind `OPENCODE_EXPERIMENTAL_LSP_TOOL`. Without it the hook is a silent no-op.

## Layout

| File | Role |
|------|------|
| `src/plugin.ts` | `tool.execute.after` hook |
| `src/tui.ts` | TUI module (`id` + sidebar slot) |
| `src/entry.mjs` | npm `./tui` loader → compiled `dist/tui.ts` |
| `scripts/build-tui.ts` | Solid-compile TUI graph into `dist/` |
| `src/compact.ts` | Protocol JSON → DTO |
| `src/outline.ts` | Symbol DTO → indented outline |
| `src/format.ts` | `applyLspOutput` flags + stringify / outline |
| `src/cli.ts` | `install` / `doctor` |
| `tests/qa/` | Captured tsserver documentSymbol outline gate |

Omit `compact` / `minified` → `true`. Both false is identity.

## Releases

Version comes from `package.json`. Tag must be `v$version` and publishes to **next**. Do not automate `latest`; promote with `npm dist-tag add`. Workflow: `.github/workflows/publish.yml` (`environment: npm`, OIDC `id-token: write`). Token not used. The tagged commit must be an ancestor of `origin/master` or the workflow fails before publish. If a tag's publish fails, fix the workflow and retry the **same** version (delete and recreate `v$version` if needed). Do not bump `package.json` for a version that never landed on the registry.
