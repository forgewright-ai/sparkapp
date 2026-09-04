#!/bin/bash
# sparkchat release -- bump the version in its four homes, build both
# targets, tag, and publish a GitHub Release with the artifacts.
#
# usage: scripts/release.sh <version> "<one-line summary>"
#        scripts/release.sh --current   (release the version already set)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
. "$HOME/.cargo/env" 2>/dev/null || true

CURRENT=$(node -p "require('./package.json').version")

if [ "$1" = "--current" ]; then
  VERSION="$CURRENT"
else
  VERSION="$1"; SUMMARY="$2"
  [ -n "$VERSION" ] || { echo "usage: $0 <version> \"summary\" | --current" >&2; exit 1; }
  echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "version must be X.Y.Z" >&2; exit 1; }
fi

# the version lives in four files; keep them in lockstep
bump() {
  [ "$VERSION" = "$CURRENT" ] && return 0
  node -e "
    const fs = require('fs');
    for (const f of ['package.json']) {
      const j = JSON.parse(fs.readFileSync(f)); j.version = '$VERSION';
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
    }
    const t = 'src-tauri/tauri.conf.json';
    const j = JSON.parse(fs.readFileSync(t)); j.version = '$VERSION';
    fs.writeFileSync(t, JSON.stringify(j, null, 2) + '\n');
  "
  sed -i '' "s/^version = \"$CURRENT\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
  sed -i '' "s/APP_VERSION = \".*\"/APP_VERSION = \"$VERSION\"/" src/version.ts
  (cd src-tauri && cargo update -p sparkchat -q)  # sync Cargo.lock
  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock src/version.ts
  git commit -m "release: v$VERSION -- $SUMMARY"
}

grep -q "## v$VERSION" CHANGELOG.md || { echo "CHANGELOG.md needs a '## v$VERSION' section first" >&2; exit 1; }

bump
scripts/build-production.sh all

DMG=$(ls src-tauri/target/release/bundle/dmg/sparkchat_${VERSION}_*.dmg)
EXE=$(ls src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/sparkchat_${VERSION}_*.exe)

git push
git tag -a "v$VERSION" -m "sparkchat v$VERSION"
git push origin "v$VERSION"

NOTES=$(awk "/^## v$VERSION/{f=1;next} /^## /{f=0} f" CHANGELOG.md)
gh release create "v$VERSION" "$DMG" "$EXE" --title "sparkchat v$VERSION" --notes "$NOTES"
echo "released v$VERSION"
