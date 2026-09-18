#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# gitbot Sandbox Setup Script
# Idempotent — safe to run on every sandbox reboot.
# =============================================================================

# --- Detect workspace user ---------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  WORKSPACE_USER=$(getent passwd | awk -F: '$3 >= 1000 && $3 < 65534 && $7 !~ /nologin|false/ {print $1; exit}')
  if [ -z "$WORKSPACE_USER" ]; then
    echo "ERROR: Could not detect a non-root workspace user." >&2
    exit 1
  fi
  echo "Detected workspace user: $WORKSPACE_USER (running as root, will switch)"
  exec sudo -u "$WORKSPACE_USER" bash "$0" "$@"
fi

# From here on we are the workspace user.
WORKSPACE_USER=$(id -un)
HOME_DIR=$(getent passwd "$WORKSPACE_USER" | cut -d: -f6)
echo "Running setup as: $WORKSPACE_USER (home: $HOME_DIR)"

# --- Paths -------------------------------------------------------------------
GITBOT_WORKSPACE="$HOME_DIR/start"
GITBOT_CONFIG_DIR="$HOME_DIR/.config/gitbot"
GITBOT_ENV_FILE="$GITBOT_CONFIG_DIR/env"
GITBOT_PORT=3000
GITBOT_LOG="$GITBOT_CONFIG_DIR/gitbot.log"
RELAY_URL="wss://relay.codeongrass.com"

# --- Create workspace folder -------------------------------------------------
echo ""
echo "==> Creating workspace folder: $GITBOT_WORKSPACE"
mkdir -p "$GITBOT_WORKSPACE"

# --- Install gitbot -----------------------------------------------------------
echo ""
echo "==> Installing gitbot-ai globally"
if ! gitbot -V &>/dev/null; then
  npm install -g gitbot-ai
  if ! gitbot -V &>/dev/null; then
    echo "ERROR: gitbot not found after install." >&2
    exit 1
  fi
fi
echo "gitbot installed: $(gitbot -V)"

# --- Create config directory and env file ------------------------------------
echo ""
echo "==> Writing environment file: $GITBOT_ENV_FILE"
mkdir -p "$GITBOT_CONFIG_DIR"

cat > "$GITBOT_ENV_FILE" <<EOF
# gitbot sandbox environment
# Add secrets here (e.g. ANTHROPIC_API_KEY, GITHUB_TOKEN).
# This file is readable only by $WORKSPACE_USER.
# gitbot-api will append secrets here during provisioning.

GITBOT_PORT=$GITBOT_PORT
GITBOT_WORKSPACE=$GITBOT_WORKSPACE
EOF

chmod 600 "$GITBOT_ENV_FILE"
echo "Env file written and locked to owner-read-only."

# --- Register cron @reboot entry (idempotent) --------------------------------
echo ""
echo "==> Registering cron @reboot entry"
(crontab -l 2>/dev/null | grep -Ev 'grass|gitbot' || true; echo "@reboot nohup bash -c \"cd '$GITBOT_WORKSPACE' && gitbot start -p $GITBOT_PORT -r $RELAY_URL\" >> $GITBOT_LOG 2>&1 &") | crontab -
echo "Cron entry registered."

# --- Kill any existing gitbot process and start fresh -------------------------
echo ""
echo "==> Starting gitbot"
pkill -x gitbot 2>/dev/null || true
pkill -x grass 2>/dev/null || true  # pre-rename binary, if still running
sleep 1
nohup bash -c "cd '$GITBOT_WORKSPACE' && gitbot start -p $GITBOT_PORT -r $RELAY_URL" >> "$GITBOT_LOG" 2>&1 &
echo "gitbot started (pid $!)"

# --- Health check ------------------------------------------------------------
echo ""
echo "==> Waiting for gitbot to become healthy on port $GITBOT_PORT"
MAX_ATTEMPTS=30
ATTEMPT=0
until curl -sf "http://localhost:$GITBOT_PORT/health" > /dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    echo "ERROR: gitbot did not become healthy after ${MAX_ATTEMPTS} attempts." >&2
    echo "Check logs at: $GITBOT_LOG" >&2
    tail -n 50 "$GITBOT_LOG" >&2 || true
    exit 1
  fi
  echo "  Attempt $ATTEMPT/$MAX_ATTEMPTS — waiting..."
  sleep 2
done

echo ""
echo "================================================================"
echo "  gitbot sandbox setup complete."
echo "  Logs:    $GITBOT_LOG"
echo "  Env:     $GITBOT_ENV_FILE"
echo "  Port:    $GITBOT_PORT"
echo "================================================================"
