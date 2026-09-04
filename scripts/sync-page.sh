#!/bin/sh
# sync-page.sh -- vendor the spark page into page/ at the pinned ref.
#
#   scripts/sync-page.sh
#       clone spark at the ref in scripts/spark-page.ref and copy
#       lib/spark/forge/* into page/, mirroring forgeserve.py's mount:
#       index.html + manifest.webmanifest at the root, everything else
#       under page/static/ (the page loads /static/spark.css etc.)
#   SPARK_DIR=../spark scripts/sync-page.sh
#       clone from a local spark repo instead of github
#   SPARK_REF=worktree SPARK_DIR=../spark scripts/sync-page.sh
#       copy the working tree as-is (dev loop; no clone, no ref)
set -eu

cd "$(dirname "$0")/.."

REF="${SPARK_REF:-$(cat scripts/spark-page.ref)}"
REPO="${SPARK_DIR:-https://github.com/forgewright-ai/spark}"

TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT

if [ "$REF" = "worktree" ]; then
  SRC="${SPARK_DIR:-../spark}/lib/spark/forge"
else
  TMP="$(mktemp -d)"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$REF" "$REPO" "$TMP/spark" || {
    echo "cannot clone $REPO at $REF -- check scripts/spark-page.ref" >&2
    exit 1
  }
  SRC="$TMP/spark/lib/spark/forge"
fi

[ -d "$SRC" ] || {
  echo "no page at $SRC -- is that a spark checkout?" >&2
  exit 1
}

rm -rf page
mkdir -p page/static
for f in "$SRC"/*; do
  case "$(basename "$f")" in
    index.html|manifest.webmanifest) cp "$f" page/ ;;
    *) cp "$f" page/static/ ;;
  esac
done
echo "page/ synced from $SRC (ref $REF)"
