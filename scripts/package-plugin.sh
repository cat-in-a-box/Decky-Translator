#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
dependencies="${1:-plugin-dependencies.tar.gz}"
artifact="${2:-$(pwd)/out/Decky.Language.Tutor.zip}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

test -f dist/index.js || { echo "Run pnpm build first." >&2; exit 1; }
test -f "$dependencies" || { echo "Missing $dependencies. Build the Linux dependency archive first." >&2; exit 1; }

plugin="$stage/decky-language-tutor"
mkdir -p "$plugin/bin" "$plugin/py_modules" "$(dirname "$artifact")"
cp main.py package.json plugin.json README.md LICENSE THIRD_PARTY_LICENSES "$plugin/"
cp -R dist assets "$plugin/"
cp -R py_modules/providers "$plugin/py_modules/"
cp "$dependencies" "$plugin/bin/plugin-dependencies.tar.gz"

(
    cd "$stage"
    zip -q -r Decky.Language.Tutor.zip decky-language-tutor \
        -x '*/__pycache__/*' '*/__pycache__/' '*.pyc' '*/.DS_Store'
)
mv "$stage/Decky.Language.Tutor.zip" "$artifact"
echo "$artifact"
