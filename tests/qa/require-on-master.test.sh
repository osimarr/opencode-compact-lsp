#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/require-on-master.sh"
if [[ ! -x "$SCRIPT" ]]; then
  echo "missing executable $SCRIPT" >&2
  exit 1
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
git -C "$workdir" init -q -b master
git -C "$workdir" config user.email "test@example.com"
git -C "$workdir" config user.name "test"
echo a > "$workdir/a"
git -C "$workdir" add a
git -C "$workdir" commit -q -m "base"
MASTER="$(git -C "$workdir" rev-parse HEAD)"

echo b > "$workdir/b"
git -C "$workdir" add b
git -C "$workdir" commit -q -m "on-master"
ON_MASTER="$(git -C "$workdir" rev-parse HEAD)"

git -C "$workdir" checkout -q -b feature
echo c > "$workdir/c"
git -C "$workdir" add c
git -C "$workdir" commit -q -m "feature-only"
FEATURE="$(git -C "$workdir" rev-parse HEAD)"
git -C "$workdir" checkout -q master

run_script() {
  (cd "$workdir" && "$SCRIPT" "$1" "$2")
}

assert_ok() {
  local sha=$1
  local master_ref=$2
  run_script "$sha" "$master_ref" || {
    echo "expected success for $sha ancestor of $master_ref" >&2
    exit 1
  }
}
assert_fail() {
  local sha=$1
  local master_ref=$2
  if run_script "$sha" "$master_ref" >/dev/null 2>&1; then
    echo "expected failure for $sha ancestor of $master_ref" >&2
    exit 1
  fi
}

assert_ok "$MASTER" "$ON_MASTER"
assert_ok "$ON_MASTER" "$ON_MASTER"
assert_fail "$FEATURE" "$ON_MASTER"

git -C "$workdir" merge -q --no-ff feature -m "merge feature"
MERGED="$(git -C "$workdir" rev-parse HEAD)"
assert_ok "$FEATURE" "$MERGED"

echo "require-on-master tests ok"
