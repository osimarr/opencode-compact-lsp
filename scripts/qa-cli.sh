#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export CI=true
PLUGIN=opencode-compact-lsp

bash tests/qa/require-on-master.test.sh
bun test tests/qa/document-symbol-outline.test.ts
bun test tests/qa/tui-pack-install.test.ts

bun run build
shebang="$(head -n1 dist/cli.js)"
if [[ "$shebang" != "#!/usr/bin/env node" ]]; then
  echo "expected shebang #!/usr/bin/env node, got: $shebang" >&2
  exit 1
fi

tgz="$(bun pm pack --quiet --ignore-scripts | grep -E '\.tgz$' | tail -n 1)"
trap 'rm -f "$ROOT/$tgz"' EXIT
mapfile -t files < <(tar tzf "$tgz")
printf '%s\n' "${files[@]}"
assert_pack() {
  local needle=$1
  printf '%s\n' "${files[@]}" | grep -q "$needle" || {
    echo "pack missing $needle" >&2
    exit 1
  }
}
assert_pack "package/dist/cli.js"
assert_pack "package/dist/tui.ts"
assert_pack "package/dist/tui/stats-sidebar.tsx"
assert_pack "package/src/entry.mjs"
assert_pack "package/src/plugin.ts"
assert_pack "package/src/tui.ts"
assert_pack "package/src/plugin-id.ts"
assert_pack "package/src/compact.ts"
assert_pack "package/src/format.ts"
assert_pack "package/src/outline.ts"
assert_pack "package/src/options.ts"
printf '%s\n' "${files[@]}" | grep -q '\.env' && {
  echo "pack must not include .env" >&2
  exit 1
}

VERSION="$(node -p "require('$ROOT/package.json').version")"

assert_spec() {
  local dir=$1
  local spec=$2
  node -e "
    const plugins = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).plugin
    if (!(plugins || []).includes(process.argv[2])) {
      console.error('expected', process.argv[2], 'in', process.argv[1], 'got', plugins)
      process.exit(1)
    }
  " "$dir/opencode.json" "$spec"
  node -e "
    const plugins = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).plugin
    if (!(plugins || []).includes(process.argv[2])) {
      console.error('expected', process.argv[2], 'in', process.argv[1], 'got', plugins)
      process.exit(1)
    }
  " "$dir/tui.json" "$spec"
}

tgz_path="$ROOT/$tgz"

echo "== install via $PLUGIN binary =="
bindir="$(mktemp -d)"
printf '%s\n' '{"type":"module"}' > "$bindir/package.json"
cp dist/cli.js "$bindir/$PLUGIN.js"
cat > "$bindir/$PLUGIN" << EOF
#!/usr/bin/env node
import "./$PLUGIN.js"
EOF
chmod +x "$bindir/$PLUGIN"
d_bin="$(mktemp -d)"
env -u npm_config_user_agent \
  PATH="$bindir:/usr/local/bin:/usr/bin:/bin" \
  OPENCODE_CONFIG_DIR="$d_bin" \
  CI=true \
  "$PLUGIN" install --global | tee /tmp/$PLUGIN-bin.log
grep -q "$PLUGIN install" /tmp/$PLUGIN-bin.log || grep -q "^  $PLUGIN" /tmp/$PLUGIN-bin.log
assert_spec "$d_bin" "$PLUGIN"

echo "== install via npx =="
if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required for QA install cases" >&2
  exit 1
fi
d_npx="$(mktemp -d)"
env OPENCODE_CONFIG_DIR="$d_npx" CI=true npx --yes --package "$tgz_path" -- "$PLUGIN" install --global | tee /tmp/$PLUGIN-npx.log
grep -q "npx $PLUGIN" /tmp/$PLUGIN-npx.log
assert_spec "$d_npx" "$PLUGIN@$VERSION"

echo "== install via bunx =="
d_bunx="$(mktemp -d)"
work="$(mktemp -d)"
(
  cd "$work"
  bun add "$tgz_path"
  env OPENCODE_CONFIG_DIR="$d_bunx" CI=true bunx "$PLUGIN" install --global
) | tee /tmp/$PLUGIN-bunx.log
grep -q "bunx $PLUGIN" /tmp/$PLUGIN-bunx.log
assert_spec "$d_bunx" "$PLUGIN@$VERSION"

echo "== install via bunx @latest path =="
latest_root="$(mktemp -d)/$PLUGIN@latest"
mkdir -p "$latest_root"
cp dist/cli.js "$latest_root/cli.js"
d_latest="$(mktemp -d)"
env OPENCODE_CONFIG_DIR="$d_latest" CI=true bun "$latest_root/cli.js" install --global
assert_spec "$d_latest" "$PLUGIN@latest"

echo "== install via npx @next path =="
next_root="$(mktemp -d)/$PLUGIN@next"
mkdir -p "$next_root"
cp dist/cli.js "$next_root/cli.js"
d_next="$(mktemp -d)"
env npm_config_user_agent="npm/10.9.2 node/v22.0.0" \
  OPENCODE_CONFIG_DIR="$d_next" CI=true \
  bun "$next_root/cli.js" install --global
assert_spec "$d_next" "$PLUGIN@next"

echo "== doctor --fix via bunx @latest path =="
d_fix="$(mktemp -d)"
env OPENCODE_CONFIG_DIR="$d_fix" CI=true bun "$latest_root/cli.js" doctor --fix --global
assert_spec "$d_fix" "$PLUGIN@latest"

echo "== replace pinned version with @latest then @next =="
d_rep="$(mktemp -d)"
ver_root="$(mktemp -d)/$PLUGIN@$VERSION"
mkdir -p "$ver_root"
cp dist/cli.js "$ver_root/cli.js"
env OPENCODE_CONFIG_DIR="$d_rep" CI=true bun "$ver_root/cli.js" install --global
assert_spec "$d_rep" "$PLUGIN@$VERSION"
env OPENCODE_CONFIG_DIR="$d_rep" CI=true bun "$latest_root/cli.js" install --global
assert_spec "$d_rep" "$PLUGIN@latest"
env OPENCODE_CONFIG_DIR="$d_rep" CI=true bun "$next_root/cli.js" doctor --fix --global
assert_spec "$d_rep" "$PLUGIN@next"
node -e "
  const plugins = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).plugin
  const n = plugins.filter((p) => {
    const name = Array.isArray(p) ? p[0] : p
    return String(name).startsWith(process.argv[2])
  }).length
  if (n !== 1) {
    console.error('expected 1', process.argv[2], 'entry, got', n, plugins)
    process.exit(1)
  }
 " "$d_rep/opencode.json" "$PLUGIN"
node -e "
  const plugins = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).plugin
  const n = plugins.filter((p) => String(p).startsWith(process.argv[2])).length
  if (n !== 1) {
    console.error('expected 1', process.argv[2], 'tui entry, got', n, plugins)
    process.exit(1)
  }
" "$d_rep/tui.json" "$PLUGIN"

# shellcheck source=install-opencode.sh
source "$(dirname "$0")/install-opencode.sh"
opencode --version

config="$(mktemp -d)"
export OPENCODE_CONFIG_DIR="$config"
trap 'rm -rf "$config" "$bindir" "$d_bin" "$d_npx" "$d_bunx" "$work" "$d_latest" "$d_next" "$d_fix" "$d_rep"; rm -f "$ROOT/$tgz"' EXIT
bun dist/cli.js doctor --fix --global
bun dist/cli.js doctor
echo "qa-cli ok"
