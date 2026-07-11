#!/usr/bin/env bash
# Install flow: download → install → deps → setup → run
# Code lives in ~/.local/share/pastureprotocol; state in ~/.pasture
set -e

POST_INSTALL_CMD=
[ "$1" = "-c" ] && [ -n "${2:-}" ] && POST_INSTALL_CMD="$2"

BRANCH="${PASTURE_BRANCH:-master}"
TARBALL="https://github.com/bishwashere/pastureprotocol/archive/refs/heads/${BRANCH}.tar.gz"

INSTALL_DIR="${PASTURE_INSTALL_DIR:-$HOME/.local/share/pastureprotocol}"
BIN_DIR="$HOME/.local/bin"

echo ""
echo "  Welcome to Pasture Protocol — WhatsApp bot with your own LLM"
echo "  ------------------------------------------------"
echo ""

# --- sanity checks -------------------------------------------------

command -v node >/dev/null 2>&1 || {
  echo "  ✖ Node.js is required but not installed."
  exit 1
}

# --- temp workspace ------------------------------------------------

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

THEME_CYAN="$(printf '\033[36m')"
ANSI_RESET="$(printf '\033[0m')"

ok() {
  printf '%s%s%s\n' "$THEME_CYAN" "$1" "$ANSI_RESET"
}

download_with_retries() {
  local url="$1"
  local out="$2"
  local label="${3:-Download}"
  local attempts="${PASTURE_DOWNLOAD_RETRIES:-3}"
  local delay="${PASTURE_DOWNLOAD_RETRY_DELAY:-3}"
  local n=1

  while [ "$n" -le "$attempts" ]; do
    rm -f "$out"
    if curl -fsSL --connect-timeout "${PASTURE_CURL_CONNECT_TIMEOUT:-30}" --max-time "${PASTURE_CURL_MAX_TIME:-900}" "$url" -o "$out"; then
      return 0
    fi
    if [ "$n" -lt "$attempts" ]; then
      echo "  [WARN] $label failed (attempt $n/$attempts). Retrying in ${delay}s..."
      sleep "$delay"
    fi
    n=$((n + 1))
  done

  echo "  ✖ $label failed after $attempts attempts."
  return 1
}

# --- download ------------------------------------------------------

echo "  ► Downloading..."
download_with_retries "$TARBALL" "$WORK/archive.tar.gz" "Download release"
tar xzf "$WORK/archive.tar.gz" -C "$WORK"
EXTRACTED=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$EXTRACTED" ] || { echo "  ✖ Archive extract failed."; exit 1; }
ok "  ✓ Done."
echo ""

# --- install code --------------------------------------------------

echo "  ► Installing to $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"

rsync -a --exclude=node_modules "$EXTRACTED/" "$INSTALL_DIR/" 2>/dev/null \
  || cp -R "$EXTRACTED/"* "$INSTALL_DIR/"

cd "$INSTALL_DIR"

# Record build info (best effort)
INSTALL_BUILD=$(node --input-type=module -e "
  import { fetchRemoteBuild, writeBuild } from 'file://$INSTALL_DIR/lib/util/build-info.js';
  const b = await fetchRemoteBuild('$BRANCH');
  if (b) { writeBuild('$INSTALL_DIR', b); console.log(b); }
" 2>/dev/null || true)

ok "  ✓ Code installed.${INSTALL_BUILD:+ (build $INSTALL_BUILD)}"
echo ""

# --- launcher ------------------------------------------------------

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/pasture" <<LAUNCHER
#!/usr/bin/env bash
export PASTURE_INSTALL_DIR="$INSTALL_DIR"
exec node "$INSTALL_DIR/cli.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/pasture"

echo "  ► Launcher installed: $BIN_DIR/pasture"

# --- PATH setup ----------------------------------------------------

PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
ADDED_PATH=0

add_path_to() {
  local f="$1"
  [ -f "$f" ] || touch "$f" 2>/dev/null || return 0
  grep -q '.local/bin' "$f" 2>/dev/null && return 0
  echo "" >> "$f"
  echo "# Pasture Protocol" >> "$f"
  echo "$PATH_LINE" >> "$f"
  echo "  ► Added ~/.local/bin to PATH in $f"
  ADDED_PATH=1
}

if ! command -v pasture >/dev/null 2>&1; then
  add_path_to "${ZDOTDIR:-$HOME}/.zshrc"
  add_path_to "${ZDOTDIR:-$HOME}/.zprofile"
  add_path_to "$HOME/.bashrc"
  add_path_to "$HOME/.profile"
  [ "$ADDED_PATH" = 1 ] && echo "  ► Open a new terminal, or run:  source ~/.zshrc   (then run: pasture start)"
fi

echo ""

# --- dependency install (must run before setup.js) -----------------

install_deps() {
  echo "  ► Installing dependencies..."

  if [ -d node_modules ] && [ -d node_modules/dotenv ] && [ -f node_modules/@openai/codex/bin/codex.js ]; then
    ok "  ✓ Dependencies already installed."
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  elif command -v npm >/dev/null 2>&1; then
    npm install
  else
    echo "  ✖ Neither pnpm nor npm found. Install Node.js properly."
    exit 1
  fi

  if [ ! -f node_modules/@openai/codex/bin/codex.js ]; then
    echo "  ✖ OpenAI browser-login runtime is missing after dependency install."
    exit 1
  fi

  ok "  ✓ Dependencies installed."
}

install_deps
echo ""

# --- setup ---------------------------------------------------------

if [ -n "$POST_INSTALL_CMD" ]; then
  ok "  ✓ Setup skipped (non-interactive -c mode)."
  echo ""
  echo "  ------------------------------------------------"
  echo "  To start the bot:  pasture start"
  echo ""
else
  echo "  ► Setting up (config + WhatsApp link)..."
  echo "  (You will link WhatsApp in a moment. When you are done and want to stop the bot, press Ctrl+C.)"
  echo ""

  trap '' INT

  if [ -t 0 ]; then
    node setup.js || true
  elif [ -e /dev/tty ]; then
    node setup.js < /dev/tty || true
  else
    echo "  No terminal. Run manually:"
    echo "  cd $INSTALL_DIR && node setup.js"
  fi

  trap - INT

  echo ""
  echo "  ------------------------------------------------"

  export PATH="$BIN_DIR:$PATH"
  export PASTURE_INSTALL_DIR="$INSTALL_DIR"

  if "$BIN_DIR/pasture" start; then
    echo "  ► Bot is running in the background. You can close this terminal."
    echo "  ► To see logs: pasture logs"
  else
    echo "  ► To start later: pasture start"
  fi

  echo ""
  exit 0
fi

# --- post install shell (-c mode) ----------------------------------

if [ -n "$POST_INSTALL_CMD" ]; then
  echo "  ► Running in new shell: $POST_INSTALL_CMD"
  exec "${SHELL:-/bin/zsh}" -l -c "$POST_INSTALL_CMD"
elif [ "$ADDED_PATH" = 1 ] && [ -t 0 ]; then
  echo "  ► Restarting shell so pasture is available..."
  exec "${SHELL:-/bin/zsh}" -l
fi
