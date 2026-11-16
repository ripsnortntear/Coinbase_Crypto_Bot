#!/usr/bin/env bash
# ==============================================================================
# Coinbase Crypto Bot - Start Script
# Works on any Linux distro (systemd, OpenRC, BusyBox, container, etc.)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DATA_DIR="${SCRIPT_DIR}/data"
PID_FILE="${DATA_DIR}/bot.pid"
LOG_FILE="${DATA_DIR}/app.log"

mkdir -p "$DATA_DIR"

# If bundled portable node exists, use it
if [ -f "${SCRIPT_DIR}/runtime/node/bin/node" ]; then
    export PATH="${SCRIPT_DIR}/runtime/node/bin:$PATH"
fi

# Locate Node binary
NODE_BIN=$(command -v node 2>/dev/null)
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] Node.js binary not found in PATH."
    echo "Please run ./setup.sh first to install Node.js."
    exit 1
fi

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[INFO] Coinbase Crypto Bot is already running with PID ${OLD_PID}."
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# Check if compiled dist exists
if [ ! -f "dist/index.js" ]; then
    echo "[INFO] dist/index.js not found. Compiling TypeScript..."
    npm run build
fi

# Foreground mode for containers/terminals
if [ "$1" = "--foreground" ] || [ "$1" = "-f" ]; then
    echo "[INFO] Starting Coinbase Crypto Bot in foreground..."
    exec "$NODE_BIN" dist/index.js
fi

# Background daemon mode (nohup)
echo "[INFO] Starting Coinbase Crypto Bot in background..."
nohup "$NODE_BIN" dist/index.js >> "$LOG_FILE" 2>&1 &
BOT_PID=$!
echo "$BOT_PID" > "$PID_FILE"

sleep 1
if kill -0 "$BOT_PID" 2>/dev/null; then
    echo "[SUCCESS] Coinbase Crypto Bot started successfully with PID ${BOT_PID}."
    echo "Logs:   ${LOG_FILE}"
    echo "Status: ./status.sh"
    echo "Stop:   ./stop.sh"
else
    echo "[ERROR] Failed to start Coinbase Crypto Bot. Check ${LOG_FILE} for details."
    exit 1
fi
