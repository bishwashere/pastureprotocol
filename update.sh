#!/usr/bin/env bash
# Update cowCode in place: download latest code, keep your config, auth, and cron jobs.
# Run from inside your cowCode folder:  cd cowCode && curl -fsSL ... | bash
# Or:  cd cowCode && bash update.sh
set -e

BRANCH="${COWCODE_BRANCH:-master}"
TARBALL="https://github.com/bishwashere/cowCode/archive/refs/heads/${BRANCH}.tar.gz"
EXTRACTED="cowCode-${BRANCH}"

# Run from project root (where package.json and index.js exist)
ROOT="${COWCODE_ROOT:-$PWD}"
if [ ! -f "$ROOT/package.json" ] || [ ! -f "$ROOT/index.js" ]; then
  echo ""
  echo "  Run from inside your cowCode folder, or use:  cowcode update"
  echo "  Manual:  cd ~/.local/share/cowcode && curl -fsSL https://raw.githubusercontent.com/bishwashere/cowCode/${BRANCH}/update.sh | bash"
  echo ""
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

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
  if [ -n "$LOCAL_VER" ] && curl -fsSL -H "Cache-Control: no-cache" -H "Pragma: no-cache" "https://raw.githubusercontent.com/bishwashere/cowCode/${BRANCH}/package.json?t=$(date +%s)" -o "$REMOTE_JSON" 2>/dev/null; then
    REMOTE_VER=$(node -p "require('$REMOTE_JSON').version" 2>/dev/null || true)
    if [ -n "$REMOTE_VER" ] && [ "$LOCAL_VER" = "$REMOTE_VER" ]; then
      echo ""
      echo "  Already up to date (v$LOCAL_VER)."
      echo ""
      exit 0
    fi
  fi
fi

# Show before/after so user sees the update applied
BEFORE_VER=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)
REMOTE_JSON="${REMOTE_JSON:-$WORK/remote_package.json}"
[ ! -f "$REMOTE_JSON" ] && curl -fsSL -H "Cache-Control: no-cache" "https://raw.githubusercontent.com/bishwashere/cowCode/${BRANCH}/package.json?t=$(date +%s)" -o "$REMOTE_JSON" 2>/dev/null || true
AFTER_VER=$(node -p "require('$REMOTE_JSON').version" 2>/dev/null || true)

echo ""
echo "  cowCode — Updating..."
if [ -n "$BEFORE_VER" ] && [ -n "$AFTER_VER" ]; then
  echo "  From v$BEFORE_VER → v$AFTER_VER"
elif [ -n "$AFTER_VER" ]; then
  echo "  To v$AFTER_VER"
fi
echo "  ------------------------------------------------"
echo ""

# State dir: config/auth/cron live here (new installs and after migration)
STATE_DIR="${COWCODE_STATE_DIR:-$HOME/.cowcode}"
mkdir -p "$STATE_DIR" "$STATE_DIR/cron" "$STATE_DIR/auth_info"

# One-time migration only: if state dir has no config but ROOT has data, copy to state dir.
# We never overwrite existing ~/.cowcode/config.json (user's priority and model choices are preserved on update).
if [ ! -f "$STATE_DIR/config.json" ] && [ -f "$ROOT/config.json" ]; then
  echo "  ► Migrating config to $STATE_DIR"
  cp "$ROOT/config.json" "$STATE_DIR/"
  [ -f "$ROOT/.env" ]            && cp "$ROOT/.env" "$STATE_DIR/"
  [ -f "$ROOT/cron/jobs.json" ]  && cp "$ROOT/cron/jobs.json" "$STATE_DIR/cron/"
  [ -d "$ROOT/auth_info" ]       && rm -rf "$STATE_DIR/auth_info" && cp -R "$ROOT/auth_info" "$STATE_DIR/"
fi

echo "  ► Downloading latest..."
curl -fsSL "$TARBALL" -o "$WORK/archive.tar.gz"
tar xzf "$WORK/archive.tar.gz" -C "$WORK"
SRC="$WORK/$EXTRACTED"

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

# Show after-version so user sees the update applied
NOW_VER=$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)
echo ""
if [ -n "$NOW_VER" ]; then
  echo "  ✓ Update complete. Now at v$NOW_VER"
else
  echo "  ✓ Update complete."
fi
echo "  Start the bot:  cowcode start"
echo "  If already running, restart to use new version:  cowcode restart"
echo "  (Config and skills are preserved; no fresh install needed.)"
echo ""
