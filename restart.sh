#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if command -v systemctl >/dev/null 2>&1 && systemctl is-active coinbase-crypto-bot.service >/dev/null 2>&1; then
    echo "[INFO] Restarting systemd service..."
    sudo systemctl restart coinbase-crypto-bot.service
    sudo systemctl status coinbase-crypto-bot.service --no-pager
else
    "$SCRIPT_DIR/stop.sh"
    sleep 1
    "$SCRIPT_DIR/start.sh"
fi
