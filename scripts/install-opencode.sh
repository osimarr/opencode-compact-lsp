#!/usr/bin/env bash
set -euo pipefail
if command -v opencode >/dev/null 2>&1; then
  return 0 2>/dev/null || exit 0
fi
if command -v bun >/dev/null 2>&1; then
  bun add -g opencode-ai
  export PATH="$(bun pm bin -g):$PATH"
fi
if ! command -v opencode >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  npm i -g opencode-ai
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode is not on PATH after install" >&2
  echo "PATH=$PATH" >&2
  bun pm bin -g >&2 || true
  ls -la "$(bun pm bin -g 2>/dev/null || echo /nonexistent)" >&2 || true
  return 1 2>/dev/null || exit 1
fi
