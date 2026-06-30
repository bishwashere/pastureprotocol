#!/usr/bin/env bash
# Verify install/update tarball extract finds pastureprotocol-master (not hardcoded Pasture-*).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

BRANCH="${PASTURE_BRANCH:-master}"
TARBALL="https://github.com/bishwashere/pastureprotocol/archive/refs/heads/${BRANCH}.tar.gz"

echo "=== Downloading tarball ==="
curl -fsSL "$TARBALL" -o "$WORK/archive.tar.gz"
tar xzf "$WORK/archive.tar.gz" -C "$WORK"
SRC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$SRC" ] || { echo "FAIL: no extracted folder"; exit 1; }
[ -f "$SRC/package.json" ] || { echo "FAIL: package.json missing in $SRC"; exit 1; }
[ -f "$SRC/index.js" ] || { echo "FAIL: index.js missing in $SRC"; exit 1; }
basename "$SRC" | grep -q pastureprotocol || {
  echo "FAIL: expected pastureprotocol-* folder, got $(basename "$SRC")"
  exit 1
}
echo "OK: extracted $(basename "$SRC") with package.json + index.js"
