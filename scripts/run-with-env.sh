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

read_node_version_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  sed -n 's/#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//; /^[[:space:]]*$/d; p; q' "$file"
}

resolve_node_from_version() {
  local version="$1"
  [ -n "$version" ] || return 1
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local candidate=""
  if [ -s "$nvm_dir/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$nvm_dir/nvm.sh" >/dev/null 2>&1 || true
    candidate="$(nvm which "$version" 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  case "$version" in
    v*) candidate="$nvm_dir/versions/node/$version/bin/node" ;;
    *) candidate="$nvm_dir/versions/node/v$version/bin/node" ;;
  esac
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

resolve_node_binary() {
  local version_file version candidate
  for version_file in "$INSTALL_DIR/.nvmrc" "$INSTALL_DIR/.node-version"; do
    version="$(read_node_version_file "$version_file" || true)"
    if candidate="$(resolve_node_from_version "$version" 2>/dev/null)"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if [ -n "${NODE:-}" ]; then
    candidate="$(command -v "$NODE" 2>/dev/null || true)"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  candidate="$(PATH="$INSTALL_DIR/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH" command -v node 2>/dev/null || true)"
  [ -n "$candidate" ] && printf '%s\n' "$candidate" || printf 'node\n'
}

NODE="$(resolve_node_binary)"
exec "$NODE" "$INSTALL_DIR/index.js" "$@"
