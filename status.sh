#!/usr/bin/env bash
# ==============================================================================
# Coinbase Crypto Bot - Status Script
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="${SCRIPT_DIR}/data/bot.pid"
LOG_FILE="${SCRIPT_DIR}/data/app.log"

echo "=================================================================="
echo "          ⚡ COINBASE CRYPTO BOT - PROCESS STATUS                 "
echo "=================================================================="

# Check systemd first if active
if command -v systemctl >/dev/null 2>&1 && systemctl is-active coinbase-crypto-bot.service >/dev/null 2>&1; then
    echo "Service Mode: systemd (active)"
    systemctl status coinbase-crypto-bot.service --no-pager
    exit 0
fi

# Check standalone PID
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Status:   RUNNING"
        echo "PID:      ${PID}"
        
        # Display memory and CPU if ps supports it
        if command -v ps >/dev/null 2>&1; then
            ps -p "$PID" -o pid,user,%cpu,%mem,vsz,rss,etime,comm 2>/dev/null || true
        fi

        # Check listening port
        if [ -f .env ]; then
            PORT=$(grep "^PORT=" .env | cut -d= -f2)
            echo "Port:     ${PORT:-29600}"
        fi

        echo ""
        echo "--- Recent Logs (${LOG_FILE}) ---"
        if [ -f "$LOG_FILE" ]; then
            tail -n 15 "$LOG_FILE"
        else
            echo "No log file found at ${LOG_FILE}"
        fi
        exit 0
    else
        echo "Status:   STOPPED (Stale PID file found for PID ${PID})"
        rm -f "$PID_FILE"
        exit 1
    fi
else
    echo "Status:   STOPPED (No active process found)"
    exit 1
fi
