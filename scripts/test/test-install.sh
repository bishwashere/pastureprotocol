#!/usr/bin/env bash
# Test: run ONLY the installer (with -c so it runs pasture in the new shell). No other commands.
# If pasture is not found after install, the installer is wrong and must be fixed.
set -e
TEST_HOME="${TMPDIR:-/tmp}/pasture-test-home.$$"
TEST_DIR="${TMPDIR:-/tmp}/pasture-test-dir.$$"
INSTALL_SH="$(cd "$(dirname "$0")/../.." && pwd)/install.sh"
rm -rf "$TEST_DIR" "$TEST_HOME"
mkdir -p "$TEST_HOME" "$TEST_DIR"
cd "$TEST_DIR"
echo "=== Running ONLY the installer (with -c 'which pasture && echo INSTALL_OK') ==="
out=$(HOME="$TEST_HOME" bash "$INSTALL_SH" -c "which pasture && echo INSTALL_OK" 2>&1) || true
echo "$out"
if echo "$out" | grep -q "INSTALL_OK"; then
  echo ""
  echo "=== PASS: installer works; pasture was found in the new shell ==="
else
  echo ""
  echo "=== FAIL: installer did not leave pasture on PATH (INSTALL_OK not seen) ==="
  rm -rf "$TEST_DIR" "$TEST_HOME"
  exit 1
fi
rm -rf "$TEST_DIR" "$TEST_HOME"
