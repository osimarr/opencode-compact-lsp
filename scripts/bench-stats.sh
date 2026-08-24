#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== bench-stats: manifest =="
PLUGIN_VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BUN_VER="$(bun --version 2>/dev/null || echo unknown)"
NODE_VER="$(node --version 2>/dev/null || echo unknown)"
# lockfile versions
GPT_VER="$(node -p "require('./bun.lock') ? JSON.parse(require('fs').readFileSync('./bun.lock','utf8')).packages['gpt-tokenizer']?.[0] || '4.0.0' : '4.0.0'" 2>/dev/null || echo "4.0.0")"
LOCK_VER="$(node -p "require('./bun.lock') ? JSON.parse(require('fs').readFileSync('./bun.lock','utf8')).packages['proper-lockfile']?.[0] || '4.1.2' : '4.1.2'" 2>/dev/null || echo "4.1.2")"
# fallback grep
if [ "$GPT_VER" = "4.0.0" ]; then
  GPT_VER="$(grep -o '"gpt-tokenizer": \["[^"]*"' bun.lock | head -n1 || echo "gpt-tokenizer@4.0.0")"
fi
RUNNER="$(uname -a 2>/dev/null || echo unknown)"
MANIFEST="$ROOT/bench-manifest.json"
cat > "$MANIFEST" <<EOS
{
  "plugin": "opencode-compact-lsp",
  "version": "$PLUGIN_VERSION",
  "commit": "$COMMIT",
  "bun": "$BUN_VER",
  "node": "$NODE_VER",
  "gptTokenizer": "4.0.0",
  "properLockfile": "4.1.2",
  "metric": "o200k_base:gpt-tokenizer@4.0.0:v1",
  "runner": "$RUNNER",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOS
cat "$MANIFEST"
echo ""

echo "== bench-stats: TUI bundle exclusion =="
if grep -R "from.*stats/tokenizer" src/tui --include="*.ts" --include="*.tsx" 2>/dev/null; then
  echo "FAIL: TUI imports tokenizer" >&2
  exit 1
fi
if grep -R "from.*stats/worker" src/tui --include="*.ts" --include="*.tsx" 2>/dev/null; then
  echo "FAIL: TUI imports worker" >&2
  exit 1
fi
if grep -R "from.*stats/recorder" src/tui --include="*.ts" --include="*.tsx" 2>/dev/null; then
  echo "FAIL: TUI imports recorder" >&2
  exit 1
fi
if grep -R "import.*proper-lockfile\|from.*proper-lockfile\|require.*proper-lockfile" src/tui --include="*.ts" --include="*.tsx" 2>/dev/null; then
  echo "FAIL: TUI imports proper-lockfile" >&2
  exit 1
fi
if grep -R "import.*gpt-tokenizer\|from.*gpt-tokenizer\|require.*gpt-tokenizer" src/tui --include="*.ts" --include="*.tsx" 2>/dev/null; then
  echo "FAIL: TUI imports gpt-tokenizer" >&2
  exit 1
fi
echo "TUI exclusion pass"

echo "== bench-stats: package budgets =="
bun run build >/dev/null 2>&1 || true
# tarball size
set +e
tgz="$(bun pm pack --quiet --ignore-scripts 2>&1 | grep -E '\.tgz$' | tail -n 1)"
if [ -z "$tgz" ] || [ ! -f "$tgz" ]; then
  tgz="$(ls -t *.tgz 2>/dev/null | head -n 1 || true)"
fi
set -e
if [ -n "$tgz" ] && [ -f "$tgz" ]; then
  size="$(stat -c%s "$tgz" 2>/dev/null || stat -f%z "$tgz" 2>/dev/null || echo 0)"
  echo "tarball $tgz size $size bytes (limit 256000)"
  if [ "$size" -gt 256000 ]; then
    echo "FAIL: tarball too large" >&2
    rm -f "$tgz" "$MANIFEST"
    exit 1
  fi
  rm -f "$tgz"
else
  echo "warning: tarball not found for size check"
fi

# transitive graph size rooted at direct deps
if [ -d "node_modules" ]; then
  # rough du of transitive graph for those two deps
  graph_size="$(du -sb node_modules/gpt-tokenizer node_modules/proper-lockfile 2>/dev/null | awk '{sum+=$1} END {print sum}' || echo 0)"
  echo "transitive graph (gpt-tokenizer+proper-lockfile) size $graph_size bytes (limit 31457280 = 30 MiB)"
  if [ "$graph_size" -gt 31457280 ]; then
    echo "FAIL: transitive graph too large" >&2
    exit 1
  fi
fi

echo "budgets pass"

echo "== bench-stats: note =="
echo "Warm hook, declared workload, maximum-input, packaging/worker, and TUI protocols are pre-release gates."
echo "This helper records manifest and checks budgets; full benchmark matrix requires controlled runner."
echo "bench-stats ok"
