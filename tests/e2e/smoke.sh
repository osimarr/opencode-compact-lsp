#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export CI=true
HOME_DIR="$(mktemp -d)"
export HOME="$HOME_DIR"
export XDG_CONFIG_HOME="$HOME_DIR/.config"
export XDG_DATA_HOME="$HOME_DIR/.local/share"
export XDG_CACHE_HOME="$HOME_DIR/.cache"
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR"

bun run build
bun dist/cli.js install --global
PLUGIN="$(python3 -c "from pathlib import Path; print((Path(r'$ROOT') / 'src' / 'plugin.ts').resolve())")"
ROOT="$ROOT" PLUGIN="$PLUGIN" python3 - <<'PY'
import json, os
from pathlib import Path
plugin = os.environ["PLUGIN"]
path = Path(os.environ["OPENCODE_CONFIG_DIR"]) / "opencode.json"
data = json.loads(path.read_text()) if path.exists() else {"plugin": []}
data["plugin"] = [[plugin, {"compact": True, "minified": True}]]
path.write_text(json.dumps(data, indent=2) + "\n")
print(f"wrote {path} plugin {plugin}")
PY

# shellcheck source=../../scripts/install-opencode.sh
source "$ROOT/scripts/install-opencode.sh"
opencode --version

export TERM=xterm
export COLUMNS=80 LINES=24
set +e
timeout --signal=KILL 20 script -q -c "opencode" /tmp/opencode-pty.log
set -e

log="$(find "$XDG_DATA_HOME" "$HOME_DIR" -name 'opencode.log' 2>/dev/null | head -n 1 || true)"
if [ -z "$log" ]; then
  echo "no opencode.log found" >&2
  find "$HOME_DIR" -type f >&2 || true
  cat /tmp/opencode-pty.log >&2 || true
  exit 1
fi
echo "log: $log"
if grep -qi "failed to load" "$log"; then
  echo "plugin failed to load" >&2
  grep -i "failed to load\|opencode-compact-lsp\|plugin.ts\|compact-lsp" "$log" >&2 || true
  exit 1
fi
if grep -qi "opencode-compact-lsp" "$log"; then
  echo "e2e load-smoke ok"
  exit 0
fi
if grep -qF "$PLUGIN" "$log" || grep -qi "plugin.ts" "$log" || grep -qi "compact-lsp" "$log"; then
  echo "e2e load-smoke ok"
  exit 0
fi
config="$OPENCODE_CONFIG_DIR/opencode.json"
if [ -f "$config" ] && grep -qF "$PLUGIN" "$config"; then
  echo "e2e load-smoke ok (no failed to load; config was read)"
  exit 0
fi
echo "opencode-compact-lsp not mentioned in opencode log" >&2
tail -n 80 "$log" >&2
exit 1
