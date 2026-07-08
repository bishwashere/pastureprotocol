#!/usr/bin/env bash
# Update Pasture Protocol in place: download latest code, keep your config, auth, and cron jobs.
# Run from inside your Pasture Protocol folder:  cd Pasture Protocol && curl -fsSL ... | bash
# Or:  cd Pasture Protocol && bash update.sh
set -e

BRANCH="${PASTURE_BRANCH:-master}"
TARBALL="https://github.com/bishwashere/pastureprotocol/archive/refs/heads/${BRANCH}.tar.gz"

# Run from project root (where package.json and index.js exist)
ROOT="${PASTURE_ROOT:-${PASTURE_ROOT:-$PWD}}"
if [ ! -f "$ROOT/package.json" ] || [ ! -f "$ROOT/index.js" ]; then
  echo ""
  echo "  Run from inside your Pasture Protocol folder, or use:  pasture update"
  echo "  Manual:  cd ~/.local/share/pastureprotocol && curl -fsSL https://raw.githubusercontent.com/bishwashere/pastureprotocol/${BRANCH}/update.sh | bash"
  echo ""
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

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

# Git short SHA for install dir (BUILD file or .git); remote via GitHub API
read_build() {
  node --input-type=module -e "
    import { readBuild } from 'file://$ROOT/lib/util/build-info.js';
    const b = readBuild('$ROOT');
    if (b) console.log(b);
  " 2>/dev/null || {
    [ -f "$ROOT/BUILD" ] && tr -d '[:space:]' < "$ROOT/BUILD" && return
    [ -d "$ROOT/.git" ] && git -C "$ROOT" rev-parse --short HEAD 2>/dev/null
  }
  return 0
}

fetch_remote_build() {
  local sha
  sha=$(node --input-type=module -e "
    import { fetchRemoteBuild } from 'file://$ROOT/lib/util/build-info.js';
    const b = await fetchRemoteBuild('$BRANCH');
    if (b) console.log(b);
  " 2>/dev/null) || true
  if [ -n "$sha" ]; then
    echo "$sha"
    return
  fi
  sha=$(git ls-remote https://github.com/bishwashere/pastureprotocol.git "refs/heads/${BRANCH}" 2>/dev/null \
    | awk 'NR==1 { print substr($1, 1, 7) }') || true
  [ -n "$sha" ] && echo "$sha"
  return 0
}

format_version_label() {
  node --input-type=module -e "
    import { formatVersionLabel } from 'file://$ROOT/lib/util/build-info.js';
    console.log(formatVersionLabel(process.argv[1], process.argv[2] || ''));
  " "$1" "${2:-}" 2>/dev/null || {
    if [ -n "${2:-}" ]; then echo "v$1 ($2)"; else echo "v$1"; fi
  }
}

write_build() {
  local build="$1"
  [ -z "$build" ] && return
  node --input-type=module -e "
    import { writeBuild } from 'file://$ROOT/lib/util/build-info.js';
    writeBuild('$ROOT', '$build');
  " 2>/dev/null || echo "$build" > "$ROOT/BUILD"
}

# Skip version check when --force or -f is passed
FORCE_UPDATE=
for arg in "$@"; do
  [ "$arg" = "--force" ] || [ "$arg" = "-f" ] && FORCE_UPDATE=1 && break
done

# Compare with latest: skip update if already on same version (unless --force)
if [ -z "$FORCE_UPDATE" ]; then
  LOCAL_VER=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)
  REMOTE_JSON="$WORK/remote_package.json"
  # Avoid cached package.json (raw.githubusercontent.com can serve stale)
  if [ -n "$LOCAL_VER" ] && curl -fsSL -H "Cache-Control: no-cache" -H "Pragma: no-cache" "https://raw.githubusercontent.com/bishwashere/pastureprotocol/${BRANCH}/package.json?t=$(date +%s)" -o "$REMOTE_JSON" 2>/dev/null; then
    REMOTE_VER=$(node -p "require('$REMOTE_JSON').version" 2>/dev/null || true)
    if [ -n "$REMOTE_VER" ] && [ "$LOCAL_VER" = "$REMOTE_VER" ]; then
      LOCAL_BUILD=$(read_build)
      REMOTE_BUILD=$(fetch_remote_build)
      if [ -n "$LOCAL_BUILD" ] && [ -n "$REMOTE_BUILD" ] && [ "$LOCAL_BUILD" = "$REMOTE_BUILD" ]; then
        echo ""
        echo "  Already up to date ($(format_version_label "$LOCAL_VER" "$LOCAL_BUILD"))."
        echo ""
        exit 0
      fi
    fi
  fi
fi

# Show before/after so user sees the update applied
BEFORE_VER=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)
REMOTE_JSON="${REMOTE_JSON:-$WORK/remote_package.json}"
[ ! -f "$REMOTE_JSON" ] && curl -fsSL -H "Cache-Control: no-cache" "https://raw.githubusercontent.com/bishwashere/pastureprotocol/${BRANCH}/package.json?t=$(date +%s)" -o "$REMOTE_JSON" 2>/dev/null || true
AFTER_VER=$(node -p "require('$REMOTE_JSON').version" 2>/dev/null || true)
BEFORE_BUILD=$(read_build)
AFTER_BUILD=$(fetch_remote_build)
# Ensure both sides have a commit id for the update banner (API can fail; ls-remote fallback above).
if [ -z "$AFTER_BUILD" ]; then
  AFTER_BUILD=$(fetch_remote_build)
fi
if [ -z "$BEFORE_BUILD" ] && [ -d "$ROOT/.git" ]; then
  BEFORE_BUILD=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)
fi

echo ""
echo "  Pasture Protocol — Updating..."
if [ -n "$BEFORE_VER" ] && [ -n "$AFTER_VER" ]; then
  echo "  From $(format_version_label "$BEFORE_VER" "$BEFORE_BUILD") → $(format_version_label "$AFTER_VER" "$AFTER_BUILD")"
elif [ -n "$AFTER_VER" ]; then
  echo "  To $(format_version_label "$AFTER_VER" "$AFTER_BUILD")"
fi
echo "  ------------------------------------------------"
echo ""

# State dir: config/auth/cron live here
STATE_DIR="${PASTURE_STATE_DIR:-$HOME/.pasture}"
mkdir -p "$STATE_DIR" "$STATE_DIR/cron" "$STATE_DIR/auth_info"

# Fallback: ancient installs kept config inside the install dir.
if [ ! -f "$STATE_DIR/config.json" ] && [ -f "$ROOT/config.json" ]; then
  echo "  ► Migrating config from install dir to $STATE_DIR"
  cp "$ROOT/config.json" "$STATE_DIR/"
  [ -f "$ROOT/.env" ]            && cp "$ROOT/.env" "$STATE_DIR/"
  [ -f "$ROOT/cron/jobs.json" ]  && cp "$ROOT/cron/jobs.json" "$STATE_DIR/cron/"
  [ -d "$ROOT/auth_info" ]       && rm -rf "$STATE_DIR/auth_info" && cp -R "$ROOT/auth_info" "$STATE_DIR/"
fi

echo "  ► Downloading latest..."
download_with_retries "$TARBALL" "$WORK/archive.tar.gz" "Download latest release"
tar xzf "$WORK/archive.tar.gz" -C "$WORK"
SRC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -n "$SRC" ] || { echo "  ✖ Archive extract failed (empty tarball root)."; exit 1; }

echo "  ► Updating files..."
# Copy all from release over current (excluding node_modules)
for f in "$SRC"/*; do
  [ -e "$f" ] || continue
  name=$(basename "$f")
  [ "$name" = "node_modules" ] && continue
  rm -rf "$ROOT/$name"
  cp -R "$f" "$ROOT/"
done

echo "  ► Installing dependencies..."
# Prefer pnpm (project uses it); avoid running npm over pnpm node_modules (causes "matches" error).
rm -rf "$ROOT/node_modules"
(cd "$ROOT" && (pnpm install --silent 2>/dev/null || npm install --silent 2>/dev/null || true))

# Record build id and show final version
if [ -z "$AFTER_BUILD" ]; then
  AFTER_BUILD=$(fetch_remote_build)
fi
[ -n "$AFTER_BUILD" ] && write_build "$AFTER_BUILD"
NOW_VER=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)
NOW_BUILD=$(read_build)

# Refresh CLI launcher (in-place update keeps same ROOT).
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/pasture" <<LAUNCHER
#!/usr/bin/env bash
export PASTURE_INSTALL_DIR="$ROOT"
exec node "$ROOT/cli.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/pasture"

echo ""
if [ -n "$NOW_VER" ]; then
  echo "  ✓ Update complete. Now at $(format_version_label "$NOW_VER" "$NOW_BUILD")"
else
  echo "  ✓ Update complete."
fi
echo "  Start the bot:  pasture start"
echo "  If already running, restart to use new version:  pasture restart"
echo "  (Config and skills are preserved; no fresh install needed.)"
echo ""
