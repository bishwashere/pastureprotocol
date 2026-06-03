#!/usr/bin/env bash
# Wrapper: load ~/.pasture/.env into the environment, then start the bot.
# Used by launchd (macOS) and systemd (Linux) so HA_URL, HA_TOKEN, etc. are available.
# PASTURE_STATE_DIR and PASTURE_INSTALL_DIR must be set by the caller.

set -e
STATE_DIR="${PASTURE_STATE_DIR:-$HOME/.pasture}"
INSTALL_DIR="${PASTURE_INSTALL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export PASTURE_STATE_DIR="$STATE_DIR"
export PASTURE_INSTALL_DIR="$INSTALL_DIR"

if [ -f "$STATE_DIR/.env" ]; then
  set -a
  set +e
  . "$STATE_DIR/.env" 2>/dev/null
  set -e
  set +a
fi

NODE="${NODE:-$(command -v node 2>/dev/null || true)}"
[ -z "$NODE" ] && NODE="node"
exec "$NODE" "$INSTALL_DIR/index.js" "$@"
