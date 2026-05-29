#!/usr/bin/env bash
# Install flow: download → launcher + PATH → setup (deps, config, WhatsApp link, bot runs).
# New shell is created only after setup.js exits (user presses Ctrl+C to stop the bot).
# Code lives in ~/.local/share/cowcode (fixed path); state in ~/.cowcode. Same idea as OpenClaw.
set -e
POST_INSTALL_CMD=
[ "$1" = "-c" ] && [ -n "${2:-}" ] && POST_INSTALL_CMD="$2"

BRANCH="${COWCODE_BRANCH:-master}"
TARBALL="https://github.com/bishwashere/cowCode/archive/refs/heads/${BRANCH}.tar.gz"
EXTRACTED="cowCode-${BRANCH}"
# Fixed install path — no path dependency (like OpenClaw global install)
INSTALL_DIR="${COWCODE_INSTALL_DIR:-$HOME/.local/share/cowcode}"
BIN_DIR="$HOME/.local/bin"

echo ""
echo "  Welcome to cowCode — WhatsApp bot with your own LLM"
echo "  ------------------------------------------------"
echo ""

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "  ► Downloading..."
curl -fsSL "$TARBALL" -o "$WORK/archive.tar.gz"
tar xzf "$WORK/archive.tar.gz" -C "$WORK"
echo "  ✓ Done."
echo ""

echo "  ► Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
rsync -a --exclude=node_modules "$WORK/$EXTRACTED/" "$INSTALL_DIR/" 2>/dev/null || cp -R "$WORK/$EXTRACTED/"* "$INSTALL_DIR/"
cd "$INSTALL_DIR"
# Record git build id for update/status display (tarball installs have no .git)
INSTALL_BUILD=$(node --input-type=module -e "
  import { fetchRemoteBuild, writeBuild } from 'file://$INSTALL_DIR/lib/build-info.js';
  const b = await fetchRemoteBuild('$BRANCH');
  if (b) { writeBuild('$INSTALL_DIR', b); console.log(b); }
" 2>/dev/null || true)
echo "  ✓ Code installed.${INSTALL_BUILD:+ (build $INSTALL_BUILD)}"
echo ""

# Launcher: fixed path only (like OpenClaw — run cowcode from anywhere)
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/cowcode" << LAUNCHER
#!/usr/bin/env bash
export COWCODE_INSTALL_DIR="$INSTALL_DIR"
exec node "$INSTALL_DIR/cli.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/cowcode"
echo "  ► Launcher installed: $BIN_DIR/cowcode"

PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
ADDED_PATH=0
add_path_to() {
  local f="$1"
  [ -f "$f" ] || touch "$f" 2>/dev/null || return 0
  grep -q '.local/bin' "$f" 2>/dev/null && return 0
  echo "" >> "$f"
  echo "# cowCode" >> "$f"
  echo "$PATH_LINE" >> "$f"
  echo "  ► Added ~/.local/bin to PATH in $f"
  ADDED_PATH=1
}
if ! command -v cowcode >/dev/null 2>&1; then
  add_path_to "${ZDOTDIR:-$HOME}/.zshrc"
  add_path_to "${ZDOTDIR:-$HOME}/.zprofile"
  add_path_to "$HOME/.bashrc"
  add_path_to "$HOME/.profile"
  [ "$ADDED_PATH" = 1 ] && echo "  ► Open a new terminal, or run:  source ~/.zshrc   (then run: cowcode start)"
fi
echo ""

echo "  ► Setting up (dependencies + config)..."
if [ -n "$POST_INSTALL_CMD" ]; then
  # Non-interactive: just install deps so cowcode can run when we exec with -c
  (cd "$INSTALL_DIR" && (pnpm install --silent 2>/dev/null || npm install --silent 2>/dev/null || true))
  echo "  ✓ Dependencies ready."
else
  echo "  (You will link WhatsApp in a moment. When you are done and want to stop the bot, press Ctrl+C.)"
  echo ""
  # Ignore Ctrl+C in this script so we always reach the exec (new shell) after setup exits
  trap '' INT
  if [ -t 0 ]; then
    node setup.js || true
  elif [ -e /dev/tty ]; then
    node setup.js < /dev/tty || true
  else
    echo "  No terminal. Run: cd $INSTALL_DIR && node setup.js"
  fi
  trap - INT
  echo ""
  echo "  ------------------------------------------------"
  # Start daemon in background (no new terminal); user can close this window.
  export PATH="$BIN_DIR:$PATH"
  export COWCODE_INSTALL_DIR="$INSTALL_DIR"
  if "$BIN_DIR/cowcode" start; then
    echo "  ► Bot is running in the background. You can close this terminal."
    echo "  ► To see logs: cowcode logs"
  else
    echo "  To start the bot later:  cowcode start"
  fi
  echo ""
  exit 0
fi
echo ""
echo "  ------------------------------------------------"
echo "  To start the bot:  cowcode start"
echo "  (or from this folder:  npm start)"
echo ""

# When -c was passed: run that command in the new shell and exit
if [ -n "$POST_INSTALL_CMD" ]; then
  echo "  ► Running in new shell: $POST_INSTALL_CMD"
  exec "${SHELL:-/bin/zsh}" -l -c "$POST_INSTALL_CMD"
elif [ "$ADDED_PATH" = 1 ] && [ -t 0 ]; then
  echo "  ► Starting a new shell so  cowcode  works in this terminal..."
  exec "${SHELL:-/bin/zsh}" -l
fi

