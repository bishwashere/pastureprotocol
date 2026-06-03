#!/usr/bin/env bash
# Uninstall pasture: stops the daemon, removes binaries, configs, and systemd/launchd services.

set -e

INSTALL_DIR="${PASTURE_INSTALL_DIR:-$HOME/.local/share/pastureprotocol}"
BIN_FILE="$HOME/.local/bin/pasture"
STATE_DIR="$HOME/.pasture"
SERVICE_NAME="pasture"
LAUNCHD_LABEL="ai.pastureprotocol.bot"

echo "  Pasture Protocol Uninstaller"
echo "  -------------------"
echo ""

# 1. Stop and remove services
case "$(uname -s)" in
  Darwin*)
    PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
    if [ -f "$PLIST" ]; then
      echo "  ► Stopping launchd agent..."
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "  ✓ Removed $PLIST"
    fi
    ;;
  Linux*)
    SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
    if [ -f "$SERVICE_FILE" ]; then
      echo "  ► Stopping systemd service..."
      systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
      systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
      rm -f "$SERVICE_FILE"
      systemctl --user daemon-reload
      echo "  ✓ Removed $SERVICE_FILE"
    fi
    ;;
esac

# 2. Remove binary launcher
if [ -f "$BIN_FILE" ]; then
  echo "  ► Removing launcher: $BIN_FILE"
  rm -f "$BIN_FILE"
  echo "  ✓ Done."
fi

# 3. Remove installed code
if [ -d "$INSTALL_DIR" ]; then
  echo "  ► Removing installed code: $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  echo "  ✓ Done."
fi

# 4. Remove state/config (WhatsApp auth, logs, settings)
if [ -d "$STATE_DIR" ]; then
  echo "  ► Removing configuration and state: $STATE_DIR"
  rm -rf "$STATE_DIR"
  echo "  ✓ Done."
fi

# 5. Clean up PATH in shell configs
remove_from_shell_config() {
  local f="$1"
  if [ -f "$f" ]; then
    if grep -q "# Pasture Protocol" "$f"; then
      echo "  ► Cleaning $f..."
      # This removes the "# Pasture Protocol" line and the line immediately after it (the PATH export)
      sed -i '/# Pasture Protocol/N; /# Pasture Protocol\nexport PATH="\$HOME\/\.local\/bin:\$PATH"/d' "$f"
      # Fallback if the newline match didn't work exactly as expected (e.g. slight variations)
      sed -i '/# Pasture Protocol/d' "$f"
      sed -i '/export PATH="\$HOME\/\.local\/bin:\$PATH"/d' "$f" 2>/dev/null || true
      echo "  ✓ Done."
    fi
  fi
}

remove_from_shell_config "${ZDOTDIR:-$HOME}/.zshrc"
remove_from_shell_config "${ZDOTDIR:-$HOME}/.zprofile"
remove_from_shell_config "$HOME/.bashrc"
remove_from_shell_config "$HOME/.profile"

echo ""
echo "  ------------------------------------------------"
echo "  ✓ Pasture Protocol has been successfully uninstalled."
echo "  (Note: The current repository folder was not deleted.)"
echo "  To start fresh, you can now run: ./install.sh"
echo ""
