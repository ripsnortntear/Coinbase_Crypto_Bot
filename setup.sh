#!/usr/bin/env bash
# ==============================================================================
# Coinbase Crypto Bot - Universal Self-Contained Setup & Deployment Wizard
# Compatible with ALL Linux Distros (Ubuntu, Debian, Kali, Raspberry Pi,
# Alpine, Fedora, CentOS, RHEL, Arch, openSUSE, BusyBox, etc.)
# ==============================================================================

set -e
export DEBIAN_FRONTEND=noninteractive

# ANSI Color Codes
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

clear 2>/dev/null || true

echo -e "${CYAN}${BOLD}"
echo "=================================================================="
echo "          ⚡ COINBASE CRYPTO BOT - UNIVERSAL SETUP WIZARD         "
echo "   Automated HFT/DCA Cryptocurrency Trading Engine & Terminal    "
echo "=================================================================="
echo -e "${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ------------------------------------------------------------------------------
# 1. Hardware & OS Detection
# ------------------------------------------------------------------------------
echo -e "${YELLOW}>> [1/6] Detecting Operating System & Hardware Architecture...${NC}"

ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64)   NODE_ARCH="x64" ;;
    aarch64|arm64)  NODE_ARCH="arm64" ;;
    armv7l|armhf)   NODE_ARCH="armv7l" ;;
    i686|i386)      NODE_ARCH="x86" ;;
    *)              NODE_ARCH="$ARCH" ;;
esac

OS_NAME="unknown"
PKG_MGR="unknown"

if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME="${ID:-unknown}"
elif [ -f /etc/alpine-release ]; then
    OS_NAME="alpine"
elif [ -f /etc/debian_version ]; then
    OS_NAME="debian"
fi

if command -v apt-get >/dev/null 2>&1; then
    PKG_MGR="apt"
elif command -v dnf >/dev/null 2>&1; then
    PKG_MGR="dnf"
elif command -v yum >/dev/null 2>&1; then
    PKG_MGR="yum"
elif command -v apk >/dev/null 2>&1; then
    PKG_MGR="apk"
elif command -v pacman >/dev/null 2>&1; then
    PKG_MGR="pacman"
elif command -v zypper >/dev/null 2>&1; then
    PKG_MGR="zypper"
fi

echo -e "${GREEN}  ✓ Architecture: ${BOLD}${ARCH}${NC} (Node mapping: ${NODE_ARCH})"
echo -e "${GREEN}  ✓ Linux Distro: ${BOLD}${OS_NAME}${NC} (Package Manager: ${PKG_MGR})"
echo ""

# Helper: run command with sudo if not root
run_privileged() {
    if [ "$EUID" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        echo -e "${RED}[ERROR] Root or sudo privileges required for: $*${NC}"
        return 1
    fi
}

# ------------------------------------------------------------------------------
# 2. Check and Auto-Install Node.js (Target: >= 22.0.0 for native node:sqlite)
# ------------------------------------------------------------------------------
echo -e "${YELLOW}>> [2/6] Verifying Node.js & Runtime Environment...${NC}"

# If bundled portable node exists, use it
if [ -f "${SCRIPT_DIR}/runtime/node/bin/node" ]; then
    export PATH="${SCRIPT_DIR}/runtime/node/bin:$PATH"
fi

NEED_NODE_INSTALL=false

if ! command -v node >/dev/null 2>&1; then
    NEED_NODE_INSTALL=true
    echo "  → Node.js is not currently installed."
else
    NODE_VER=$(node -v | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
    if [ "$NODE_MAJOR" -lt 22 ]; then
        echo "  → Node.js $NODE_VER detected. Node.js 22+ is required for native embedded SQLite."
        NEED_NODE_INSTALL=true
    else
        echo -e "${GREEN}  ✓ Node.js $(node -v) is ready.${NC}"
    fi
fi

if [ "$NEED_NODE_INSTALL" = true ]; then
    echo -e "${CYAN}Coinbase Crypto Bot requires Node.js v22+ (LTS) for embedded zero-database operation.${NC}"
    read -rp "Would you like to automatically install Node.js 22 LTS now? (y/n) [Default: y]: " INSTALL_NODE_CHOICE
    INSTALL_NODE_CHOICE="${INSTALL_NODE_CHOICE:-y}"

    if [[ "$INSTALL_NODE_CHOICE" =~ ^[Yy]$ ]]; then
        INSTALLED=false

        # Ensure curl or wget is installed
        if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
            echo "  → Installing curl..."
            case "$PKG_MGR" in
                apt)    run_privileged apt-get update && run_privileged apt-get install -y curl ca-certificates xz-utils ;;
                dnf)    run_privileged dnf install -y curl xz ;;
                yum)    run_privileged yum install -y curl xz ;;
                apk)    run_privileged apk add --no-cache curl ca-certificates xz ;;
                pacman) run_privileged pacman -Sy --noconfirm curl xz ;;
                zypper) run_privileged zypper install -y curl xz ;;
            esac
        fi

        # Option A: Install via package manager repository if root/sudo is available
        if [ "$EUID" -eq 0 ] || command -v sudo >/dev/null 2>&1; then
            echo "  → Attempting package manager installation..."
            case "$PKG_MGR" in
                apt)
                    if curl -fsSL https://deb.nodesource.com/setup_22.x | run_privileged bash - && run_privileged apt-get install -y nodejs; then
                        INSTALLED=true
                    fi
                    ;;
                dnf)
                    if curl -fsSL https://rpm.nodesource.com/setup_22.x | run_privileged bash - && run_privileged dnf install -y nodejs; then
                        INSTALLED=true
                    fi
                    ;;
                yum)
                    if curl -fsSL https://rpm.nodesource.com/setup_22.x | run_privileged bash - && run_privileged yum install -y nodejs; then
                        INSTALLED=true
                    fi
                    ;;
                apk)
                    if run_privileged apk add --no-cache nodejs npm; then
                        INSTALLED=true
                    fi
                    ;;
                pacman)
                    if run_privileged pacman -Sy --noconfirm nodejs npm; then
                        INSTALLED=true
                    fi
                    ;;
            esac
        fi

        # Option B: Standalone Portable Binary Fallback (Works on BusyBox, non-root, Raspberry Pi, any distro)
        if [ "$INSTALLED" = false ] || ! command -v node >/dev/null 2>&1; then
            echo "  → Installing standalone portable Node.js v22 LTS into local runtime..."
            NODE_TAR="node-v22.14.0-linux-${NODE_ARCH}.tar.xz"
            NODE_URL="https://nodejs.org/dist/v22.14.0/${NODE_TAR}"
            
            mkdir -p "${SCRIPT_DIR}/runtime"
            cd "${SCRIPT_DIR}/runtime"
            
            if command -v curl >/dev/null 2>&1; then
                curl -fsSL -O "$NODE_URL"
            elif command -v wget >/dev/null 2>&1; then
                wget -q "$NODE_URL"
            fi
            
            if [ -f "$NODE_TAR" ]; then
                tar -xf "$NODE_TAR"
                rm -f "$NODE_TAR"
                rm -rf node && mv "node-v22.14.0-linux-${NODE_ARCH}" node
                export PATH="${SCRIPT_DIR}/runtime/node/bin:$PATH"
                INSTALLED=true
                echo -e "${GREEN}  ✓ Standalone Node.js 22 installed to ${SCRIPT_DIR}/runtime/node/${NC}"
            else
                echo -e "${RED}[ERROR] Failed to download standalone Node.js binary.${NC}"
                exit 1
            fi
            cd "$SCRIPT_DIR"
        fi
    else
        echo -e "${RED}[ERROR] Node.js 22+ is required to proceed. Setup aborted.${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}  ✓ Active Node: $(command -v node) ($(node -v))${NC}"
echo -e "${GREEN}  ✓ Active npm:  $(command -v npm) ($(npm -v))${NC}"
echo ""

# ------------------------------------------------------------------------------
# 3. Interactive Configuration Prompts (Minimal Friction / Smart Defaults)
# ------------------------------------------------------------------------------
echo -e "${YELLOW}>> [3/6] Network & Administrative Credentials...${NC}"
echo -e "${CYAN}Tip: Press [ENTER] to accept recommended defaults for any prompt.${NC}"
echo ""

# FQDN
echo -e "${BOLD}1. Fully Qualified Domain Name (FQDN)${NC}"
read -rp "Domain or IP [Default: localhost]: " INPUT_FQDN
FQDN="${INPUT_FQDN:-localhost}"
echo -e "${CYAN}  → Target Domain: ${BOLD}$FQDN${NC}"
echo ""

# Port
echo -e "${BOLD}2. Listening Port${NC}"
read -rp "Web Server Port [Default: 29600]: " INPUT_PORT
PORT="${INPUT_PORT:-29600}"
echo -e "${CYAN}  → Listening Port: ${BOLD}$PORT${NC}"
echo ""

# Base Path (Auto-default to '/' if localhost)
if [ "$FQDN" = "localhost" ] || [ "$FQDN" = "127.0.0.1" ]; then
    BASE_PATH="/"
else
    echo -e "${BOLD}3. Base URL Path${NC}"
    read -rp "Base URL Path (e.g. '/' for root, or '/crypto' for subpath) [Default: /]: " INPUT_BASE_PATH
    BASE_PATH="${INPUT_BASE_PATH:-/}"
    if [ "$BASE_PATH" != "/" ]; then
        BASE_PATH="/${BASE_PATH#/}"
        BASE_PATH="${BASE_PATH%/}"
    fi
fi
echo -e "${CYAN}  → Base Path: ${BOLD}$BASE_PATH${NC}"
echo ""

# Admin Credentials
echo -e "${BOLD}4. Admin Credentials for Dashboard Access${NC}"
read -rp "Admin Username [Default: admin]: " INPUT_ADMIN_USER
ADMIN_USER="${INPUT_ADMIN_USER:-admin}"

echo -e "Admin Password:"
read -rsp "Enter Admin Password (or press [ENTER] to auto-generate a secure password): " INPUT_ADMIN_PASS
echo ""

if [ -z "$INPUT_ADMIN_PASS" ]; then
    AUTO_HEX=$(node -e "console.log(require('crypto').randomBytes(4).toString('hex'))")
    AUTO_HEX2=$(node -e "console.log(require('crypto').randomBytes(4).toString('hex'))")
    ADMIN_PASS="CbBot-${AUTO_HEX}-${AUTO_HEX2}"
    echo -e "${YELLOW}${BOLD}  ★ Auto-Generated Admin Password:${NC} ${GREEN}${BOLD}${ADMIN_PASS}${NC} ${YELLOW}(Please record this!)${NC}"
else
    ADMIN_PASS="$INPUT_ADMIN_PASS"
    while true; do
        if [ ${#ADMIN_PASS} -lt 6 ]; then
            echo -e "${RED}[!] Password must be at least 6 characters long.${NC}"
            read -rsp "Enter Password again: " ADMIN_PASS
            echo ""
            continue
        fi
        read -rsp "Confirm Admin Password: " ADMIN_PASS_CONFIRM
        echo ""
        if [ "$ADMIN_PASS" = "$ADMIN_PASS_CONFIRM" ]; then
            break
        else
            echo -e "${RED}[!] Passwords do not match. Please re-enter.${NC}"
            read -rsp "Enter Admin Password: " ADMIN_PASS
            echo ""
        fi
    done
fi
echo -e "${GREEN}  ✓ Admin credentials configured for '${ADMIN_USER}'.${NC}"
echo ""

# ------------------------------------------------------------------------------
# 4. Coinbase Exchange API Setup & Interactive Guide
# ------------------------------------------------------------------------------
echo -e "${YELLOW}>> [4/6] Coinbase Exchange API Setup...${NC}"
echo -e "${CYAN}${BOLD}"
echo "=================================================================="
echo "        🔑 HOW TO GET YOUR COINBASE ADVANCED TRADE API KEYS       "
echo "=================================================================="
echo -e "${NC}"
echo "Follow these 4 simple steps to connect Coinbase Advanced Trade:"
echo ""
echo -e "  ${BOLD}1. Create / Log in to Coinbase:${NC}"
echo "     Visit https://www.coinbase.com/ (ensure your account identity is verified)"
echo ""
echo -e "  ${BOLD}2. Open Coinbase Developer Platform (CDP):${NC}"
echo "     Go to: https://portal.cdp.coinbase.com/access/api"
echo "     (Or on Coinbase: click Profile Icon ➔ Settings ➔ API Keys ➔ Create API Key)"
echo ""
echo -e "  ${BOLD}3. Create New API Key:${NC}"
echo "     • Name: e.g. 'CryptoBot'"
echo "     • Portfolio: Default"
echo "     • Permissions: Check [View] AND [Trade]"
echo -e "     ${RED}⚠️ NEVER check 'Transfer' or 'Withdraw' (keep your funds secure!)${NC}"
echo ""
echo -e "  ${BOLD}4. Where to Find Your Secret Key:${NC}"
echo "     • API Key Name: Looks like: organizations/{org_id}/apiKeys/{key_id}"
echo "     • Private Key:  Coinbase will prompt you to download 'cdp_api_key.json'"
echo "       OR displays a multi-line EC Private Key in PEM format starting with:"
echo "       -----BEGIN EC PRIVATE KEY-----"
echo "       ..."
echo "       -----END EC PRIVATE KEY-----"
echo ""
echo -e "${CYAN}==================================================================${NC}"
echo ""

COINBASE_API_KEY=""
COINBASE_API_SECRET=""
COINBASE_SYMBOL="ETH/USD"
COINBASE_CAPITAL="25.00"

# Check if cdp_api_key.json is present in script directory or current working directory
LOCAL_JSON=""
if [ -f "${SCRIPT_DIR}/cdp_api_key.json" ]; then
    LOCAL_JSON="${SCRIPT_DIR}/cdp_api_key.json"
elif [ -f "./cdp_api_key.json" ]; then
    LOCAL_JSON="./cdp_api_key.json"
fi

if [ -n "$LOCAL_JSON" ]; then
    echo -e "${GREEN}${BOLD}  ★ Detected 'cdp_api_key.json' in directory!${NC}"
    read -rp "Auto-import keys from this file? (y/n) [Default: y]: " USE_AUTO_JSON
    USE_AUTO_JSON="${USE_AUTO_JSON:-y}"
    if [[ "$USE_AUTO_JSON" =~ ^[Yy]$ ]]; then
        PARSED=$(node -e "
            try {
                const fs = require('fs');
                const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
                console.log(JSON.stringify({ key: data.name || '', secret: data.privateKey || '' }));
            } catch(e) {
                console.log('{}');
            }
        " "$LOCAL_JSON")
        COINBASE_API_KEY=$(node -e "console.log(JSON.parse(process.argv[1]).key || '')" "$PARSED")
        COINBASE_API_SECRET=$(node -e "console.log(JSON.parse(process.argv[1]).secret || '')" "$PARSED")
        if [ -n "$COINBASE_API_KEY" ] && [ -n "$COINBASE_API_SECRET" ]; then
            echo -e "${GREEN}  ✓ Auto-imported API Key: ${COINBASE_API_KEY:0:28}...${NC}"
            echo -e "${GREEN}  ✓ Auto-imported Private Key Secret.${NC}"
        fi
    fi
fi

if [ -z "$COINBASE_API_KEY" ]; then
    echo -e "${BOLD}Select Setup Option:${NC}"
    echo "  [1] Enter path to 'cdp_api_key.json' (Recommended - easiest!)"
    echo "  [2] Enter API Key Name and Secret manually"
    echo "  [3] Skip for now (configure anytime from the web dashboard) [Default]"
    read -rp "Choice [1/2/3, Default: 3]: " CB_CHOICE
    CB_CHOICE="${CB_CHOICE:-3}"

    if [ "$CB_CHOICE" = "1" ]; then
        read -rp "Path to 'cdp_api_key.json': " JSON_PATH
        if [ -f "$JSON_PATH" ]; then
            PARSED=$(node -e "
                try {
                    const fs = require('fs');
                    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
                    console.log(JSON.stringify({ key: data.name || '', secret: data.privateKey || '' }));
                } catch(e) {
                    console.log('{}');
                }
            " "$JSON_PATH")
            COINBASE_API_KEY=$(node -e "console.log(JSON.parse(process.argv[1]).key || '')" "$PARSED")
            COINBASE_API_SECRET=$(node -e "console.log(JSON.parse(process.argv[1]).secret || '')" "$PARSED")
            if [ -n "$COINBASE_API_KEY" ] && [ -n "$COINBASE_API_SECRET" ]; then
                echo -e "${GREEN}  ✓ Successfully imported Coinbase credentials!${NC}"
            else
                echo -e "${RED}[!] Could not parse name and privateKey from JSON. Skipping for now.${NC}"
            fi
        else
            echo -e "${YELLOW}[!] File not found at '${JSON_PATH}'. Skipping key setup for now.${NC}"
        fi
    elif [ "$CB_CHOICE" = "2" ]; then
        read -rp "Coinbase API Key Name (e.g. organizations/.../apiKeys/...): " COINBASE_API_KEY
        echo "Coinbase API Secret:"
        echo "(You can enter the path to a .pem/.key file, or paste your Private Key)"
        read -rp "Secret or Path: " SECRET_INPUT
        if [ -f "$SECRET_INPUT" ]; then
            COINBASE_API_SECRET=$(cat "$SECRET_INPUT")
        else
            COINBASE_API_SECRET="$SECRET_INPUT"
        fi
    else
        echo -e "${CYAN}  → Skipping Coinbase keys for now. You can connect your keys anytime via the dashboard!${NC}"
    fi
fi

if [ -n "$COINBASE_API_KEY" ] && [ -n "$COINBASE_API_SECRET" ]; then
    read -rp "Trading Pair [Default: ETH/USD]: " INPUT_SYMBOL
    COINBASE_SYMBOL="${INPUT_SYMBOL:-ETH/USD}"
    read -rp "Initial Allocated Capital ($) [Default: 25.00]: " INPUT_CAPITAL
    COINBASE_CAPITAL="${INPUT_CAPITAL:-25.00}"
    echo -e "${GREEN}  ✓ Initial DCA Bot will be pre-configured for ${COINBASE_SYMBOL} with $${COINBASE_CAPITAL} capital.${NC}"
fi
echo ""

# ------------------------------------------------------------------------------
# 5. Generate Cryptographic Environment & Build
# ------------------------------------------------------------------------------
echo -e "${YELLOW}>> [5/6] Generating Secrets, Compiling & Bootstrapping Database...${NC}"

# Stop any running instance before updating configuration
if [ -f "${SCRIPT_DIR}/data/bot.pid" ]; then
    echo "  → Stopping active bot process before applying new configuration..."
    "${SCRIPT_DIR}/stop.sh" >/dev/null 2>&1 || true
fi

# Generate 64-character random hex keys using Node.js crypto (independent of openssl CLI)
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cat <<EOF > .env
# Auto-generated by Coinbase Crypto Bot setup.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
PORT=${PORT}
HOST=0.0.0.0
FQDN=${FQDN}
BASE_PATH=${BASE_PATH}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
SESSION_SECRET=${SESSION_SECRET}
ROOT_ADMIN_USER=${ADMIN_USER}
DATA_DIR=${SCRIPT_DIR}/data
EOF

chmod 600 .env
echo -e "${GREEN}  ✓ Generated .env with AES-256-GCM encryption key.${NC}"

# Install dependencies if node_modules missing
if [ ! -d "node_modules" ]; then
    echo "  → Installing npm dependencies..."
    npm install
fi

# Build TypeScript
echo "  → Compiling TypeScript source..."
npm run build
echo -e "${GREEN}  ✓ Application build complete.${NC}"

# Bootstrap SQLite database
echo "  → Bootstrapping database schema & security..."
mkdir -p "${SCRIPT_DIR}/data"
ADMIN_USER="${ADMIN_USER}" \
ADMIN_PASS="${ADMIN_PASS}" \
ENCRYPTION_KEY="${ENCRYPTION_KEY}" \
COINBASE_API_KEY="${COINBASE_API_KEY}" \
COINBASE_API_SECRET="${COINBASE_API_SECRET}" \
COINBASE_SYMBOL="${COINBASE_SYMBOL}" \
COINBASE_CAPITAL="${COINBASE_CAPITAL}" \
node scripts/bootstrap.js

# Ensure helper scripts are executable
chmod +x start.sh stop.sh status.sh restart.sh

echo ""

# ------------------------------------------------------------------------------
# 6. Service & Process Management (Adaptive across all init systems)
# ------------------------------------------------------------------------------
echo -e "${YELLOW}>> [6/6] Service & Background Process Management...${NC}"

CURRENT_USER=$(id -un)
NODE_BIN=$(command -v node)

IS_CONTAINER=false
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
    IS_CONTAINER=true
fi

HAS_SYSTEMD=false
if [ "$IS_CONTAINER" = false ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    HAS_SYSTEMD=true
fi

HAS_OPENRC=false
if [ "$IS_CONTAINER" = false ] && command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
    HAS_OPENRC=true
fi

SERVICE_INSTALLED=false

if [ "$HAS_SYSTEMD" = true ]; then
    echo -e "${BOLD}systemd init system detected.${NC}"
    read -rp "Would you like to install and start the background systemd service? (y/n) [Default: y]: " INSTALL_SYSTEMD
    INSTALL_SYSTEMD="${INSTALL_SYSTEMD:-y}"

    if [[ "$INSTALL_SYSTEMD" =~ ^[Yy]$ ]]; then
        SERVICE_FILE="/etc/systemd/system/coinbase-crypto-bot.service"
        TEMP_SERVICE="/tmp/coinbase-crypto-bot.service"

        sed -e "s|__SERVICE_USER__|${CURRENT_USER}|g" \
            -e "s|__INSTALL_DIR__|${SCRIPT_DIR}|g" \
            -e "s|__NODE_BIN__|${NODE_BIN}|g" \
            templates/systemd.service.template > "$TEMP_SERVICE"

        run_privileged cp "$TEMP_SERVICE" "$SERVICE_FILE"
        run_privileged systemctl daemon-reload
        run_privileged systemctl enable --now coinbase-crypto-bot.service
        rm -f "$TEMP_SERVICE"
        SERVICE_INSTALLED=true
        echo -e "${GREEN}  ✓ Systemd service 'coinbase-crypto-bot.service' installed and started!${NC}"
    fi

elif [ "$HAS_OPENRC" = true ]; then
    echo -e "${BOLD}OpenRC init system detected (Alpine Linux / embedded).${NC}"
    read -rp "Would you like to install the OpenRC service into /etc/init.d/? (y/n) [Default: y]: " INSTALL_OPENRC
    INSTALL_OPENRC="${INSTALL_OPENRC:-y}"

    if [[ "$INSTALL_OPENRC" =~ ^[Yy]$ ]]; then
        INIT_FILE="/etc/init.d/coinbase-crypto-bot"
        TEMP_INIT="/tmp/coinbase-crypto-bot.init"

        sed -e "s|__SERVICE_USER__|${CURRENT_USER}|g" \
            -e "s|__INSTALL_DIR__|${SCRIPT_DIR}|g" \
            -e "s|__NODE_BIN__|${NODE_BIN}|g" \
            templates/openrc.init.template > "$TEMP_INIT"

        run_privileged cp "$TEMP_INIT" "$INIT_FILE"
        run_privileged chmod +x "$INIT_FILE"
        run_privileged rc-update add coinbase-crypto-bot default 2>/dev/null || true
        run_privileged rc-service coinbase-crypto-bot start 2>/dev/null || true
        rm -f "$TEMP_INIT"
        SERVICE_INSTALLED=true
        echo -e "${GREEN}  ✓ OpenRC service installed and started!${NC}"
    fi
fi

if [ "$SERVICE_INSTALLED" = false ]; then
    echo "  → Standalone control scripts are ready:"
    echo "      ./start.sh   - Starts daemon in background (or ./start.sh --foreground)"
    echo "      ./stop.sh    - Gracefully stops the bot"
    echo "      ./status.sh  - Checks bot status, PID, memory, and logs"
    echo "      ./restart.sh - Restarts the bot"
    echo ""
    read -rp "Would you like to start Coinbase Crypto Bot now? (y/n) [Default: y]: " START_NOW
    START_NOW="${START_NOW:-y}"
    if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
        "${SCRIPT_DIR}/start.sh"
    fi
fi
echo ""

# ------------------------------------------------------------------------------
# 7. Nginx Reverse Proxy (Optional)
# ------------------------------------------------------------------------------
if [ "$FQDN" != "localhost" ]; then
    echo -e "${BOLD}Nginx Reverse Proxy Configuration (Optional)${NC}"
    echo "Note: The bot runs completely standalone on port ${PORT}. Nginx is only needed if you want port 80/443 SSL termination."
    read -rp "Would you like to generate an Nginx configuration for '${FQDN}'? (y/n) [Default: n]: " GEN_NGINX
    GEN_NGINX="${GEN_NGINX:-n}"

    if [[ "$GEN_NGINX" =~ ^[Yy]$ ]]; then
        NGINX_CONF_AVAIL="/etc/nginx/sites-available/${FQDN}"
        NGINX_CONF_ENAB="/etc/nginx/sites-enabled/${FQDN}"
        TEMP_NGINX="/tmp/nginx_${FQDN}.conf"

        NGINX_BASE=""
        if [ "$BASE_PATH" != "/" ]; then
            NGINX_BASE="$BASE_PATH"
        fi

        sed -e "s|__FQDN__|${FQDN}|g" \
            -e "s|__PORT__|${PORT}|g" \
            -e "s|__BASE_PATH__|${NGINX_BASE}|g" \
            templates/nginx.conf.template > "$TEMP_NGINX"

        if [ -d "/etc/nginx/sites-available" ]; then
            run_privileged cp "$TEMP_NGINX" "$NGINX_CONF_AVAIL"
            if [ -d "/etc/nginx/sites-enabled" ]; then
                run_privileged ln -sf "$NGINX_CONF_AVAIL" "$NGINX_CONF_ENAB"
            fi
            echo -e "${GREEN}  ✓ Nginx configuration written to ${NGINX_CONF_AVAIL}${NC}"

            if command -v nginx >/dev/null 2>&1; then
                if run_privileged nginx -t >/dev/null 2>&1; then
                    run_privileged systemctl reload nginx 2>/dev/null || run_privileged rc-service nginx reload 2>/dev/null || true
                    echo -e "${GREEN}  ✓ Nginx reloaded successfully.${NC}"
                fi
            fi

            if command -v certbot >/dev/null 2>&1; then
                read -rp "Run Certbot to automatically configure Let's Encrypt SSL for ${FQDN}? (y/n) [Default: n]: " RUN_CERTBOT
                if [[ "$RUN_CERTBOT" =~ ^[Yy]$ ]]; then
                    run_privileged certbot --nginx -d "$FQDN"
                fi
            fi
        else
            echo "  → Saved Nginx template to: ${SCRIPT_DIR}/nginx_${FQDN}.conf"
            cp "$TEMP_NGINX" "${SCRIPT_DIR}/nginx_${FQDN}.conf"
        fi
        rm -f "$TEMP_NGINX"
    fi
    echo ""
fi

# ------------------------------------------------------------------------------
# Summary Screen
# ------------------------------------------------------------------------------
echo -e "${GREEN}${BOLD}"
echo "=================================================================="
echo "          🎉 COINBASE CRYPTO BOT SETUP COMPLETED!                 "
echo "=================================================================="
echo -e "${NC}"

if [ "$FQDN" = "localhost" ]; then
    ACCESS_URL="http://localhost:${PORT}${BASE_PATH}"
else
    ACCESS_URL="http://${FQDN}:${PORT}${BASE_PATH} (or https://${FQDN}${BASE_PATH} if reverse proxied)"
fi

echo -e "${BOLD}Access Terminal:${NC}    ${CYAN}${BOLD}${ACCESS_URL}${NC}"
echo -e "${BOLD}Admin Username:${NC}     ${YELLOW}${ADMIN_USER}${NC}"
echo -e "${BOLD}Database File:${NC}      ${SCRIPT_DIR}/data/trading.db (Embedded SQLite)"
echo -e "${BOLD}Installation Dir:${NC}   ${SCRIPT_DIR}"
echo ""
echo -e "${BOLD}Useful Commands:${NC}"
if [ "$SERVICE_INSTALLED" = true ]; then
    echo "  • Status:  sudo systemctl status coinbase-crypto-bot"
    echo "  • Logs:    sudo journalctl -u coinbase-crypto-bot -f"
    echo "  • Restart: sudo systemctl restart coinbase-crypto-bot"
    echo "  • Stop:    sudo systemctl stop coinbase-crypto-bot"
else
    echo "  • Start:   ./start.sh (or ./start.sh --foreground)"
    echo "  • Status:  ./status.sh"
    echo "  • Logs:    tail -f data/app.log"
    echo "  • Restart: ./restart.sh"
    echo "  • Stop:    ./stop.sh"
fi
echo ""
echo -e "${CYAN}Happy & safe trading with Coinbase Crypto Bot! ⚡${NC}"
echo ""
