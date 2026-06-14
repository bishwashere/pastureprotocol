#!/usr/bin/env bash
# Daemon control: start | stop | status | restart
# Uses PASTURE_INSTALL_DIR (set by cli.js). State dir: ~/.pasture or PASTURE_STATE_DIR.

set -e
ACTION="${1:?Usage: pasture start|stop|status|restart}"
INSTALL_DIR="${PASTURE_INSTALL_DIR:-.}"
STATE_DIR="${PASTURE_STATE_DIR:-$HOME/.pasture}"
# Resolve INSTALL_DIR to absolute path
if [ -d "$INSTALL_DIR" ]; then
  INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
fi
[ -d "$STATE_DIR" ] || mkdir -p "$STATE_DIR"
STATE_DIR="$(cd "$STATE_DIR" && pwd)"
# Pre-create log files so "tail -f daemon.log" works immediately after start; launchd will append
touch "$STATE_DIR/daemon.log" "$STATE_DIR/daemon.err" 2>/dev/null || true
NODE="$(command -v node 2>/dev/null || true)"
[ -z "$NODE" ] && NODE="node"
# Prefer full path for launchd (minimal PATH); fallback for when "node" is not in PATH
if [ "$NODE" = "node" ] || [ -z "$NODE" ]; then
  NODE="$(PATH="/usr/local/bin:/opt/homebrew/bin:$PATH" command -v node 2>/dev/null || true)"
  [ -z "$NODE" ] && NODE="node"
fi
INDEX_JS="$INSTALL_DIR/index.js"
RUN_WITH_ENV="$INSTALL_DIR/scripts/run-with-env.sh"

# Append a control line to daemon.log so "tail -f daemon.log" shows start/stop/restart
daemon_log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] pasture $ACTION" >> "$STATE_DIR/daemon.log" 2>/dev/null || true
}

# macOS launchd
LAUNCHD_LABEL="ai.pastureprotocol.bot"
PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"

# Linux systemd user
SERVICE_NAME="pasture"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SYSTEMD_USER_DIR/${SERVICE_NAME}.service"

# Helper: check if pm2 exists, install if not
ensure_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    return 0
  fi

  echo "pm2 not found. It is required to manage the Pasture Protocol daemon."

  # Ensure npm is available
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not installed or not in PATH."
    echo "Please install pm2 manually with:"
    echo "  npm install -g pm2"
    exit 1
  fi

  # Check whether we are likely to have permission to install global packages
  NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$NPM_PREFIX" ] && [ ! -w "$NPM_PREFIX" ] && [ "$(id -u)" -ne 0 ]; then
    echo "Error: insufficient permissions to install global npm packages into:"
    echo "  $NPM_PREFIX"
    echo "Please run the following command with appropriate privileges (e.g. using sudo),"
    echo "then re-run this script:"
    echo "  npm install -g pm2"
    exit 1
  fi

  echo "Attempting to install pm2 globally with:"
  echo "  npm install -g pm2"
  if ! npm install -g pm2; then
    echo "Error: failed to install pm2. Please install it manually with:"
    echo "  npm install -g pm2"
    exit 1
  fi
}

ensure_plist() {
  [ -f "$INDEX_JS" ] || { echo "Missing $INDEX_JS. Run from Pasture Protocol install directory."; exit 1; }
  mkdir -p "$(dirname "$PLIST")"
  if [ -f "$RUN_WITH_ENV" ]; then
    RUN_CMD="/bin/bash"
    RUN_ARG="$RUN_WITH_ENV"
  else
    RUN_CMD="$NODE"
    RUN_ARG="$INDEX_JS"
  fi
  cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUN_CMD}</string>
    <string>${RUN_ARG}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${STATE_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PASTURE_STATE_DIR</key>
    <string>${STATE_DIR}</string>
    <key>PASTURE_INSTALL_DIR</key>
    <string>${INSTALL_DIR}</string>
    <key>NODE</key>
    <string>${NODE}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${STATE_DIR}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${STATE_DIR}/daemon.err</string>
</dict>
</plist>
EOF
  echo "Created $PLIST"
}

ensure_systemd_unit() {
  [ -f "$INDEX_JS" ] || { echo "Missing $INDEX_JS. Run from Pasture Protocol install directory."; exit 1; }
  mkdir -p "$SYSTEMD_USER_DIR"
  if [ -f "$RUN_WITH_ENV" ]; then
    EXEC_START="/bin/bash ${RUN_WITH_ENV}"
  else
    EXEC_START="${NODE} ${INDEX_JS}"
  fi
  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Pasture Protocol WhatsApp bot
After=network.target

[Service]
Type=simple
Environment="PASTURE_STATE_DIR=${STATE_DIR}" "PASTURE_INSTALL_DIR=${INSTALL_DIR}"
ExecStart=${EXEC_START}
WorkingDirectory=${STATE_DIR}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  echo "Created $SERVICE_FILE"
}

OS="$(uname -s 2>/dev/null || echo "$OS")"
[ -z "$OS" ] && OS="$OSTYPE"

case "$OS" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    ensure_pm2
    case "$ACTION" in
      start)
        pm2 start "$PASTURE_INSTALL_DIR/index.js" --name pasture
        echo "Started with pm2. To see logs: pm2 logs pasture"
        daemon_log
        ;;
      stop)
        pm2 stop pasture
        daemon_log
        ;;
      status)
        pm2 status pasture
        ;;
      restart)
        pm2 restart pasture
        daemon_log
        ;;
      *)
        echo "Usage: pasture start|stop|status|restart"
        ;;
    esac
    exit 0
    ;;
  Darwin)
    case "$ACTION" in
      start)
        ensure_plist
        touch "$STATE_DIR/daemon.log" "$STATE_DIR/daemon.err" 2>/dev/null || true
        if launchctl list 2>/dev/null | grep -q "$LAUNCHD_LABEL"; then
          echo "Daemon is already running. Logs: $STATE_DIR/daemon.log"
          daemon_log
        else
          if launchctl load "$PLIST"; then
            echo "Daemon started. Logs: $STATE_DIR/daemon.log"
            daemon_log
            echo "  (tail the log to see 'Pasture Protocol daemon started' when the bot is up)"
          else
            echo "Daemon failed to start. Check the error above."
            exit 1
          fi
        fi
        ;;
      stop)
        launchctl unload "$PLIST" 2>/dev/null || true
        echo "Daemon stopped."
        daemon_log
        ;;
      status)
        if launchctl list 2>/dev/null | grep -q "$LAUNCHD_LABEL"; then
          echo "Daemon is running."
          launchctl list "$LAUNCHD_LABEL" 2>/dev/null || true
        else
          echo "Daemon is not running."
        fi
        ;;
      restart)
        launchctl unload "$PLIST" 2>/dev/null || true
        sleep 1
        ensure_plist
        launchctl load "$PLIST"
        echo "Daemon restarted."
        daemon_log
        echo "  (tail $STATE_DIR/daemon.log to see 'Pasture Protocol daemon started' when the bot is up)"
        ;;
      *) echo "Usage: pasture start|stop|status|restart"; exit 1 ;;
    esac
    ;;
  Linux*)
    case "$ACTION" in
      start)
        ensure_systemd_unit
        systemctl --user daemon-reload 2>/dev/null || true
        systemctl --user enable --now "$SERVICE_NAME" 2>/dev/null || systemctl --user start "$SERVICE_NAME"
        echo "Daemon started. Logs: journalctl --user -u $SERVICE_NAME -f"
        daemon_log
        ;;
      stop)
        systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
        echo "Daemon stopped."
        daemon_log
        ;;
      status)
        systemctl --user status "$SERVICE_NAME" 2>/dev/null || echo "Daemon is not running."
        ;;
      restart)
        ensure_systemd_unit
        systemctl --user daemon-reload 2>/dev/null || true
        systemctl --user restart "$SERVICE_NAME"
        echo "Daemon restarted."
        daemon_log
        ;;
      *) echo "Usage: pasture start|stop|status|restart"; exit 1 ;;
    esac
    ;;
  *)
    echo "Daemon is supported on macOS (launchd), Linux (systemd), and Windows (pm2). Your OS: $OS"
    exit 1
    ;;
esac
