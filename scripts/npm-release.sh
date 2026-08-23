#!/usr/bin/env bash
set -euo pipefail
TAG="${1:-${GITHUB_REF_NAME:-}}"
VERSION="$(node -p "require('./package.json').version")"
if [[ -z "$TAG" ]]; then
  echo "missing git tag (pass it or set GITHUB_REF_NAME)" >&2
  exit 1
fi
if [[ "$TAG" != "v${VERSION}" ]]; then
  echo "tag $TAG does not match v${VERSION} (version from package.json)" >&2
  exit 1
fi
echo "package.json version=$VERSION tag=$TAG dist-tag=next"
if npm view "opencode-compact-lsp@${VERSION}" version >/dev/null 2>&1; then
  echo "opencode-compact-lsp@${VERSION} already published; not republishing to next" >&2
  exit 1
fi
npm publish --access public --tag next
