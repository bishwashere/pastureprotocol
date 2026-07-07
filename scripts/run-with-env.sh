#!/usr/bin/env bash
# Wrapper: load ~/.pasture/.env into the environment, then start the bot.
# Used by launchd (macOS) and systemd (Linux) so HA_URL, HA_TOKEN, etc. are available.
# PASTURE_STATE_DIR and PASTURE_INSTALL_DIR must be set by the caller.

set -e
STATE_DIR="${PASTURE_STATE_DIR:-$HOME/.pasture}"
INSTALL_DIR="${PASTURE_INSTALL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export PASTURE_STATE_DIR="$STATE_DIR"
export PASTURE_INSTALL_DIR="$INSTALL_DIR"

if [ "${PASTURE_DAEMON_DAILY_LOGS:-1}" != "0" ]; then
  LOG_DIR="${PASTURE_DAEMON_LOG_DIR:-$STATE_DIR/daily-logs/runtime}"
  mkdir -p "$LOG_DIR" 2>/dev/null || true

  write_daily_daemon_line() {
    stream="$1"
    line="$2"
    day="$(date '+%Y-%m-%d')"
    if [ "$stream" = "err" ]; then
      file="$LOG_DIR/$day.err"
      current="$LOG_DIR/current.err"
      target="$day.err"
    else
      file="$LOG_DIR/$day.log"
      current="$LOG_DIR/current.log"
      target="$day.log"
    fi
    printf '%s\n' "$line" >> "$file" 2>/dev/null || true
    ln -sfn "$target" "$current" 2>/dev/null || true
  }

  exec > >(while IFS= read -r line; do write_daily_daemon_line out "$line"; done)
  exec 2> >(while IFS= read -r line; do write_daily_daemon_line err "$line"; done)
fi

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
