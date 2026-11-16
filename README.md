# Coinbase Crypto Bot 🚀

An autonomous, high-performance, fee-shielded cryptocurrency Dollar-Cost Averaging (DCA) and Grid algorithmic trading system built for **Coinbase Advanced Trade**.

Designed to be **100% self-contained** with **zero external dependencies**—no MariaDB/MySQL/PostgreSQL, no Nginx required, and zero native C++ compilation. Adapts automatically across **Windows (10, 11, Server)** and **any Linux distribution and hardware architecture** (Raspberry Pi, Kali Linux, Ubuntu, Debian, Alpine, Fedora, Arch, BusyBox, or Docker).

---

## 🌟 Universal & Self-Contained Architecture

### 1. 100% Embedded Database (Zero External DB Setup)
- Powered natively by Node.js's built-in **`node:sqlite`** engine.
- Stores all state, trades, API keys, and sessions in a single local file: `data/trading.db`.
- **No MariaDB, no MySQL, no PostgreSQL, and no Redis required.**

### 2. Standalone Built-in Web Server (No Nginx Required)
- Features a high-concurrency embedded Express 5 HTTP & WebSocket server.
- Listens directly on your chosen port (default `29600`) and serves the real-time operations dashboard, live candlestick charts, and WebSocket streams out of the box.
- Nginx reverse proxy is **completely optional** (only needed if you want custom domain SSL termination).

### 3. Cross-Platform & Cross-Architecture Support
- **Operating Systems:**
  - **Windows:** Windows 10, Windows 11, Windows Server 2016/2019/2022/2025 (Native Batch scripts `setup.bat`, `start.bat`, `stop.bat`, `status.bat`)
  - **Linux Distributions:**
    - **Debian / Ubuntu / Kali / Raspberry Pi OS / Pop!_OS / Linux Mint** (`apt`)
    - **Alpine Linux / PostmarketOS** (`apk`, OpenRC)
    - **Fedora / CentOS / RHEL / Rocky / AlmaLinux** (`dnf` / `yum`)
    - **Arch Linux / Manjaro** (`pacman`)
    - **openSUSE** (`zypper`)
    - **Minimal / BusyBox / Embedded / Non-root environments** (automatic standalone binary fallback)
- **Hardware Architectures:**
  - `x86_64` / `amd64` (Standard PCs, Intel/AMD servers, cloud VPS)
  - `aarch64` / `arm64` (Raspberry Pi 3/4/5, Orange Pi, Rock Pi, Apple Silicon VMs, AWS Graviton)
  - `armv7l` (Raspberry Pi 2, Zero 2 W)

### 4. Zero C++ Compiler Dependency
- All packages are pure JavaScript/TypeScript.
- Requires no `gcc`, `g++`, `make`, `python`, or `node-gyp` to run.

---

## 🛡️ Built-in Trading Safeguards

1. **Coinbase Fee Shield (Anti-Loss Protection)**
   - Hardened against Coinbase's standard **0.90% taker fee (1.80% round-trip)** on market orders.
   - Enforces a minimum Take-Profit threshold of **2.00%** on DCA cycles.
   - Prevents users from accidentally creating configurations that slowly leak capital.

2. **Auto-Capital Absorption & Dynamic Sizing**
   - Automatically polls live Coinbase USD / USDC balance.
   - Dynamically calculates base orders (25%) and safety orders (20%) proportional to available equity without manual recalculations.
   - Locks order dollar fields in the UI as read-only while displaying live auto-allocation badges.

3. **Self-Contained Session Authentication**
   - Built-in login with **Scrypt** password hashing and cryptographically secure random salts.
   - AES-256-GCM encryption for Coinbase API credentials stored in SQLite.

---

## 🚀 Quickstart Installation

### Option 1: Windows Native Setup (`setup.bat`)

For Windows 10, 11, or Windows Server:

1. **Prerequisite:** Install [Node.js 22 LTS or newer](https://nodejs.org/en/download/) (standard Windows installer `.msi`).
2. **Run Installer:** Double-click **`setup.bat`** (or open Command Prompt / PowerShell in the directory and run `setup.bat`).
3. **Interactive Setup:**
   - Press `[ENTER]` through prompts to accept optimal defaults (or customize Port, Admin credentials).
   - If you have your `cdp_api_key.json` file from Coinbase, simply drop it in the folder before running `setup.bat`—it will be detected and loaded automatically!
   - The script builds TypeScript, initializes `data\trading.db`, and automatically opens your browser to the trading dashboard!
4. **Control Scripts on Windows:**
   - Double-click **`start.bat`** to start the bot.
   - Double-click **`status.bat`** to check bot status and port.
   - Double-click **`stop.bat`** to gracefully shut down the bot.

---

### Option 2: Universal Linux Interactive Installer (`setup.sh`)

Extract the archive and run `setup.sh`:

```bash
cd /mnt/storage/Coinbase_Crypto_Bot
chmod +x setup.sh
./setup.sh
```

**What `setup.sh` does automatically:**
1. **Detects Architecture & Distro:** Checks your CPU (`x64`, `arm64`, `armv7l`) and Linux flavor.
2. **Auto-Provisions Node.js 22 LTS:** If Node.js is missing or below v22, it installs it via your package manager, or downloads a self-contained portable Node.js binary into `runtime/node/` (works without root/sudo!).
3. **Generates Cryptographic Secrets:** Uses Node's built-in crypto to generate 64-character random keys for AES-256-GCM and session signing.
4. **Interactive Prompts:**
   - FQDN (defaults to `localhost` if no domain).
   - Port (default `29600`) & Base Path (default `/`).
   - Admin Username & Password.
   - Coinbase API Key & Secret (optional, can also be added later in the UI).
5. **Compiles TypeScript & Initializes SQLite:** Bootstraps `data/trading.db`.
6. **Detects Process Manager:**
   - On **systemd** systems: installs and enables `coinbase-crypto-bot.service`.
   - On **OpenRC** systems (Alpine Linux): installs `/etc/init.d/coinbase-crypto-bot`.
   - On all systems: configures standalone `./start.sh`, `./stop.sh`, and `./status.sh` scripts.

---

### Option 3: Docker Container (100% Isolated)

If Docker is installed on your machine (Windows Docker Desktop, Linux, Raspberry Pi, etc.):

```bash
cd /mnt/storage/Coinbase_Crypto_Bot
cp .env.example .env
# Edit .env with your admin credentials and session secrets
docker compose up -d
```

Access the dashboard at `http://localhost:29600` (or `http://YOUR_SERVER_IP:29600`).

---

## 🕹️ Standalone Process Management

You do not need systemd or administrator privileges to run the bot. The package includes dedicated standalone process scripts for both Linux and Windows:

| Action | Linux / macOS | Windows | Description |
| :--- | :--- | :--- | :--- |
| **Start (Background)** | `./start.sh` | `start.bat` | Launches daemon, logs to `data/app.log`, saves PID to `data/bot.pid`. |
| **Start (Foreground)** | `./start.sh --foreground` | `node dist\index.js` | Runs interactively in current terminal. |
| **Check Status** | `./status.sh` | `status.bat` | Displays process status, PID, port, and health response. |
| **Stop** | `./stop.sh` | `stop.bat` | Sends clean shutdown signal to the running process. |
| **Restart** | `./restart.sh` | `stop.bat` then `start.bat` | Gracefully cycles the bot daemon. |

---

## 🔑 How to Get Coinbase Advanced Trade API Keys & Secret

Coinbase uses Cloud Developer Platform (CDP) keys for Advanced Trade:

### Step 1: Create or Log in to Coinbase
Visit [Coinbase](https://www.coinbase.com/) and complete your account setup and identity verification (KYC).

### Step 2: Open Coinbase Developer Platform (CDP)
* Go directly to: **[https://portal.cdp.coinbase.com/access/api](https://portal.cdp.coinbase.com/access/api)**
* (Alternatively from Coinbase.com: Click your **Profile Icon** in the top right ➔ **Settings** ➔ **API Keys** ➔ **Create API Key**).

### Step 3: Create a New API Key
1. Click **Create API Key**.
2. Give your key a name (e.g., `CryptoBot`).
3. Set Portfolio to **Default**.
4. Set Permissions:
   * ✅ **View** (Required for reading balances, open orders, and price tickers)
   * ✅ **Trade** (Required for executing market orders and take-profit closes)
   * ❌ **NEVER check Transfer or Withdraw** (Keep your capital 100% secure!).

### Step 4: Where to Find Your Key Name & Secret Key
* **API Key Name:**  
  Looks like: `organizations/01234567-89ab-cdef-.../apiKeys/fedcba98-...`  
  *(A long string with slashes and UUIDs. Copy this into the setup prompt).*
* **Private Key (Secret):**  
  Coinbase will prompt you to download a JSON file named **`cdp_api_key.json`** OR will display a multi-line EC Private Key in PEM format starting with:
  ```text
  -----BEGIN EC PRIVATE KEY-----
  MHcCAQEE...
  ...
  -----END EC PRIVATE KEY-----
  ```

### 💡 Pro Tip: One-Click `cdp_api_key.json` Import!
If you downloaded **`cdp_api_key.json`** from Coinbase:
* Simply drop the file directly into the `Coinbase_Crypto_Bot/` directory!
* The `setup.sh` wizard will **automatically detect it** and instantly import both your API Key Name and your Secret Private Key without any manual copying or pasting!
* Or, you can enter the path to the downloaded file during the setup prompt.

---

## 🌐 Optional Reverse Proxy Configuration

The bot runs standalone on port `29600`. If you wish to front it with a web server for domain names, SSL/TLS certificates, or subpaths, use the configurations below.

### Option A: Apache 2.4 Configuration (`mod_proxy` + `mod_proxy_wstunnel`)

1. **Enable required Apache modules:**
   ```bash
   sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers
   sudo systemctl restart apache2
   ```

2. **Dedicated VirtualHost (Subdomain or Root Domain):**  
   Create `/etc/apache2/sites-available/crypto-bot.conf`:
   ```apache
   <VirtualHost *:80>
       ServerName crypto.yourdomain.com

       ProxyPreserveHost On
       ProxyRequests Off

       # 1. Forward WebSockets (/ws) to the trading engine
       RewriteEngine On
       RewriteCond %{HTTP:Upgrade} websocket [NC]
       RewriteCond %{HTTP:Connection} upgrade [NC]
       RewriteRule ^/?(.*) "ws://127.0.0.1:29600/$1" [P,L]

       # 2. Forward standard HTTP API requests and web UI
       ProxyPass / http://127.0.0.1:29600/
       ProxyPassReverse / http://127.0.0.1:29600/

       # Header hygiene
       RequestHeader set X-Forwarded-Proto "http"
   </VirtualHost>
   ```

3. **Subpath / Subdirectory Setup (e.g., `https://yourdomain.com/crypto`):**  
   If proxying under an existing website's subpath, add this inside your existing VirtualHost:
   ```apache
   ProxyPreserveHost On

   # Forward WebSocket connection upgrades under /crypto/
   RewriteEngine On
   RewriteCond %{HTTP:Upgrade} websocket [NC]
   RewriteCond %{HTTP:Connection} upgrade [NC]
   RewriteRule ^/crypto/(.*) "ws://127.0.0.1:29600/$1" [P,L]

   # Forward HTTP traffic
   ProxyPass /crypto/ http://127.0.0.1:29600/
   ProxyPassReverse /crypto/ http://127.0.0.1:29600/
   ```

4. **Enable Site & Obtain Free SSL:**
   ```bash
   sudo a2ensite crypto-bot.conf
   sudo systemctl reload apache2
   sudo certbot --apache -d crypto.yourdomain.com
   ```

---

### Option B: Nginx Configuration

If using Nginx, create `/etc/nginx/sites-available/crypto-bot`:

```nginx
server {
    listen 80;
    server_name crypto.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:29600;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and reload Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/crypto-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d crypto.yourdomain.com
```

---

## 📄 License
MIT License. Built for autonomous cryptocurrency trading operations across all Linux environments.
