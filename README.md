<div align="center">

# ⚡ COINBASE CRYPTO BOT
### Autonomous • Fee-Shielded • Zero-Dependency Algorithmic Trading Terminal

[![GitHub Release](https://img.shields.io/github/v/release/ripsnortntear/Coinbase_Crypto_Bot?style=for-the-badge&logo=github&color=7c3aed)](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/ripsnortntear/Coinbase_Crypto_Bot/ci.yml?style=for-the-badge&logo=githubactions&logoColor=white&label=CI%20Tests)](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-v22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Database](https://img.shields.io/badge/Database-Embedded%20node%3Asqlite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![Coinbase CDP](https://img.shields.io/badge/Coinbase-Advanced%20Trade%20CDP-0052FF?style=for-the-badge&logo=coinbase&logoColor=white)](https://portal.cdp.coinbase.com/)
[![Platforms](https://img.shields.io/badge/Platforms-Linux%20%7C%20Windows%20%7C%20Docker-blue?style=for-the-badge)](#-quickstart-installation)
[![License](https://img.shields.io/github/license/ripsnortntear/Coinbase_Crypto_Bot?style=for-the-badge&color=059669)](LICENSE)

<br/>

[**📖 Explore Wiki Documentation**](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/wiki) •
[**📦 Download Latest Release (v1.2.16)**](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/releases/latest) •
[**🐛 Report Issue**](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/issues) •
[**✨ Request Feature**](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/issues)

<p align="center">
  <img src="https://raw.githubusercontent.com/ripsnortntear/Coinbase_Crypto_Bot/main/public/style.css" alt="" width="0" height="0" />
</p>

---

</div>

## 🌟 Why Coinbase Crypto Bot?

Most crypto bots are bloated, require external databases (MySQL, Postgres, Redis), demand complex C++ compilation (`node-gyp`), or bleed money from exchange taker fees.

**Coinbase Crypto Bot is built different:**

| 🚀 Zero Dependencies | 🛡️ Coinbase Fee Shield & Risk Guards | 🧪 Backtester & Hyperopt | 🤖 Continuous ML & Visual Canvas |
| :--- | :--- | :--- | :--- |
| **No MariaDB, Postgres, or Redis.** Powered by Node.js 22 **`node:sqlite`**. Supports **all 400+ active Coinbase `/USD` markets** with native 1-click wizards for **Windows & Linux**. | **2.0% Take-Profit guard**, **Maker-First** (`postOnly`) execution, **24h Circuit Breaker**, **Per-Coin Exposure Caps**, and **Fear & Greed Regime Guard**. | Zero-look-ahead historical **Backtester**, 36-combo **Hyperopt**, and **Daily 24h Auto-Rotator** across the top 13 liquid markets with **Open-Position Protection**. | **15-min online Logistic Regression** retraining, **Portfolio Rebalancer**, **Market Maker**, **🎨 Visual Canvas**, and **Hot-Swappable Plugins**. |

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    subgraph Client["🖥️ User Terminal"]
        UI["Web Dashboard & Charts<br/>(Lightweight Charts • REST • WebSockets)"]
    end

    subgraph Host["⚡ Coinbase Crypto Bot Engine"]
        SVR["Embedded Express 5 & WS Server<br/>(Port 29600)"]
        AUTH["Scrypt Security & AES-256-GCM"]
        DB[("Embedded SQLite<br/>data/trading.db")]
        GUARD["🛡️ Regime Guard (F&G + BTC Vol)<br/>🤖 Continuous ML & Circuit Breaker"]
        RUNNER["BotRunner • Backtester • Hyperopt"]
        STRAT["DCA (Trailing TP) • Grid • Market Maker<br/>Rebalancer • 🎨 Visual Canvas • Plugins"]
        CCXT["CCXT Hybrid Maker-First Layer"]
    end

    subgraph Coinbase["☁️ Coinbase Cloud"]
        CB["Coinbase Advanced Trade API<br/>(CDP REST & WS)"]
    end

    UI <-->|"HTTP & WebSockets"| SVR
    SVR <--> AUTH
    SVR <--> DB
    SVR <--> RUNNER
    RUNNER <--> GUARD
    RUNNER <--> STRAT
    RUNNER <--> CCXT
    CCXT <-->|"CDP Ed25519 / EC-PEM"| CB
```

---

## 🚀 Quickstart Installation

Choose your operating system below for an instant setup:

<details open>
<summary><b>🪟 Windows 10 / 11 / Windows Server (Native 1-Click Wizard)</b></summary>

<br/>

1. **Install Node.js:** Download and run the official [Node.js 22 LTS Installer (.msi)](https://nodejs.org/).
2. **Download:** Grab the latest [`Coinbase_Crypto_Bot.zip`](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/releases/latest) and extract it.
3. *(Optional)* Drop your downloaded `cdp_api_key.json` file directly into the folder.
4. **Run Installer:** Double-click **`setup.bat`** and hit `[ENTER]` through prompts to accept optimal defaults.
5. **Start Trading:** The script compiles TypeScript, initializes SQLite, and pops open your browser to `http://localhost:29600`!

```cmd
# Daily Windows Controls:
start.bat    :: Starts the trading engine
status.bat   :: Checks bot health & PID
stop.bat     :: Graceful shutdown
```

</details>

<details open>
<summary><b>🐧 Linux / Raspberry Pi / macOS (Universal Interactive Installer)</b></summary>

<br/>

Extract the archive and execute the universal setup script:

```bash
git clone https://github.com/ripsnortntear/Coinbase_Crypto_Bot.git
cd Coinbase_Crypto_Bot
chmod +x setup.sh
./setup.sh
```

> [!TIP]
> **Zero Root / Sudo Required!** If Node.js is missing or below v22, `setup.sh` automatically downloads a verified portable Node.js binary into `runtime/node/` without requiring administrator privileges.

```bash
# Process Management:
./start.sh               # Run daemon in background
./start.sh --foreground  # Run interactively (ideal for tmux/screen)
./status.sh              # Check PID, memory, and live logs
./restart.sh             # Gracefully restart daemon
./stop.sh                # Clean shutdown
```

</details>

<details>
<summary><b>🐳 Docker & Docker Compose (Containerized)</b></summary>

<br/>

```bash
git clone https://github.com/ripsnortntear/Coinbase_Crypto_Bot.git
cd Coinbase_Crypto_Bot
cp .env.example .env
# Edit .env with your desired PORT and ADMIN credentials
docker compose up -d
```

Access the dashboard at `http://localhost:29600`.

</details>

---

## 🔑 Coinbase CDP API Setup (1-Click JSON Import)

Coinbase uses Cloud Developer Platform (CDP) API keys for Advanced Trade:

1. **Create API Key:** Visit [portal.cdp.coinbase.com/api-keys/secret](https://portal.cdp.coinbase.com/api-keys/secret) and click **Create API Key**.
2. **Set Permissions:**
   * ✅ **View** (Read balance & tickers)
   * ✅ **Trade** (Execute market & limit orders)
   * ❌ **NEVER check Transfer or Withdraw** (Keep your capital safe!)
3. **Download Key File:** Click **Create & Download** (or **Download JSON**) — Coinbase saves **`cdp_api_key.json`** to your browser's `Downloads` folder (`%USERPROFILE%\Downloads\` on Windows or `~/Downloads/` on Linux/macOS).
   * *Note:* Coinbase only lets you download `cdp_api_key.json` **once** at creation time. If you closed the popup without saving it, simply create a new API key.
   * *Alternative:* If you already copied the **API Key Name** (`organizations/.../apiKeys/...`) and **Private Key** (`-----BEGIN EC PRIVATE KEY-----...`), you can paste them directly into **+ Add Exchange** in the web dashboard instead.

> [!IMPORTANT]
> **1-Click Auto-Detection:** Drop `cdp_api_key.json` directly into the `Coinbase_Crypto_Bot/` directory before running `setup.sh` or `setup.bat`. The wizard will **automatically detect and load** your key name and secret private key without any manual copy-pasting!

---

## 🕹️ Process Control & CLI Cheat Sheet

| Action | Linux / macOS | Windows | Description |
| :--- | :--- | :--- | :--- |
| **Start (Background)** | `./start.sh` | `start.bat` | Launches daemon, logs to `data/app.log`, saves PID. |
| **Start (Foreground)** | `./start.sh --foreground` | `node dist\index.js` | Runs interactively in current terminal. |
| **Check Health & Status** | `./status.sh` | `status.bat` | Displays PID, CPU/RAM, port, and health response. |
| **Restart Service** | `./restart.sh` | `stop.bat` & `start.bat` | Gracefully cycles the trading engine. |
| **Stop Engine** | `./stop.sh` | `stop.bat` | Sends clean SIGTERM / shutdown signal. |
| **Run Test Suite** | `npm test` | `npm test` | Runs unit tests for Fee Shield, Backtester, Optimizer & ML. |

---

## 🌐 Optional Reverse Proxy Configuration

The bot features a built-in Express server on port `29600`. If you wish to front it with a web server for domain names, SSL certificates, or subpaths:

<details>
<summary><b>🅰️ Apache 2.4 (mod_proxy & mod_proxy_wstunnel)</b></summary>

<br/>

Enable required modules:
```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers
sudo systemctl restart apache2
```

Add to `/etc/apache2/sites-available/crypto-bot.conf`:
```apache
<VirtualHost *:80>
    ServerName crypto.yourdomain.com

    ProxyPreserveHost On
    ProxyRequests Off

    # Forward WebSockets (/ws) to trading engine
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:29600/$1" [P,L]

    # Forward HTTP REST & UI
    ProxyPass / http://127.0.0.1:29600/
    ProxyPassReverse / http://127.0.0.1:29600/

    RequestHeader set X-Forwarded-Proto "http"
</VirtualHost>
```

Activate & secure with Let's Encrypt:
```bash
sudo a2ensite crypto-bot.conf && sudo systemctl reload apache2
sudo certbot --apache -d crypto.yourdomain.com
```

</details>

<details>
<summary><b>🟩 Nginx Configuration</b></summary>

<br/>

Add to `/etc/nginx/sites-available/crypto-bot`:
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

Activate & secure with Let's Encrypt:
```bash
sudo ln -s /etc/nginx/sites-available/crypto-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d crypto.yourdomain.com
```

</details>

---

## 👥 Contributors & Credits

<div align="center">

| <a href="https://github.com/ripsnortntear"><img src="https://github.com/ripsnortntear.png" width="90px;" alt="ripsnortntear"/><br /><sub><b>ripsnortntear</b></sub></a><br /><sub>👑 Project Lead & Quantitative Architect</sub> | <a href="https://deepmind.google/"><img src="https://avatars.githubusercontent.com/u/13247077?v=4" width="90px;" alt="Antigravity"/><br /><sub><b>Antigravity AI</b></sub></a><br /><sub>🤖 Autonomous AI Engineering Partner<br/>(Google DeepMind)</sub> |
| :---: | :---: |

</div>

Special thanks to the open source projects powering our stack:
* **[Coinbase Developer Platform](https://portal.cdp.coinbase.com/)** • **[CCXT](https://github.com/ccxt/ccxt)** • **[Node.js](https://nodejs.org/)** • **[Express](https://expressjs.com/)** • **[Lightweight Charts](https://www.tradingview.com/lightweight-charts/)**

See [**CONTRIBUTORS.md**](CONTRIBUTORS.md) for full details.

---

## 📄 License

Distributed under the **GNU General Public License v3.0 (GPL-3.0)** — see [LICENSE](LICENSE) for details. Built for autonomous cryptocurrency trading operations across Windows and Linux environments.

<div align="center">
  <sub>⭐ If this project helps your trading, consider giving it a star on GitHub! ⭐</sub>
</div>
