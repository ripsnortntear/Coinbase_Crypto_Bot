#!/usr/bin/env bash
# ==============================================================================
# Coinbase Crypto Bot - Stop Script
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="${SCRIPT_DIR}/data/bot.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "[INFO] No PID file found (${PID_FILE}). Is the bot running?"
    exit 0
fi

PID=$(cat "$PID_FILE")

if ! kill -0 "$PID" 2>/dev/null; then
    echo "[INFO] Process ${PID} is not running. Cleaning up stale PID file."
    rm -f "$PID_FILE"
    exit 0
fi

echo "[INFO] Stopping Coinbase Crypto Bot (PID: ${PID})..."
kill -SIGTERM "$PID" 2>/dev/null || true

# Wait up to 10 seconds for graceful shutdown
TIMEOUT=10
while [ $TIMEOUT -gt 0 ]; do
    if ! kill -0 "$PID" 2>/dev/null; then
        break
    fi
    sleep 1
    TIMEOUT=$((TIMEOUT - 1))
done

if kill -0 "$PID" 2>/dev/null; then
    echo "[WARN] Process did not terminate gracefully. Sending SIGKILL..."
    kill -SIGKILL "$PID" 2>/dev/null || true
    sleep 1
fi

rm -f "$PID_FILE"
echo "[SUCCESS] Coinbase Crypto Bot stopped."
