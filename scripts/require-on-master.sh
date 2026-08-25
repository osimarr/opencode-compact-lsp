#!/usr/bin/env bash
set -euo pipefail
SHA="${1:-${GITHUB_SHA:-}}"
MASTER="${2:-origin/master}"
if [[ -z "$SHA" ]]; then
  SHA="$(git rev-parse HEAD)"
fi
if [[ -z "$SHA" || -z "$MASTER" ]]; then
  echo "usage: require-on-master.sh <sha> <master-ref>" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$SHA" "$MASTER"; then
  echo "refusing publish: $SHA is not an ancestor of $MASTER" >&2
  echo "tag only commits that are already on master" >&2
  exit 1
fi
