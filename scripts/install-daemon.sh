#!/usr/bin/env bash
# Install Pasture Protocol as a background daemon (launchd on macOS, systemd on Linux).
# Run from the Pasture Protocol install directory. Creates service and starts it.

set -e
INSTALL_DIR="${PASTURE_INSTALL_DIR:-$(pwd)}"
cd "$INSTALL_DIR"
[ -f "index.js" ] || { echo "Run this script from the Pasture Protocol directory."; exit 1; }
export PASTURE_INSTALL_DIR="$INSTALL_DIR"
exec bash "$(dirname "$0")/daemon.sh" start
