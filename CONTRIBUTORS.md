# Project Contributors & Acknowledgments 🤝

The **Coinbase Crypto Bot** is an autonomous cryptocurrency algorithmic trading system and terminal. This project represents the collaboration of human domain engineering and advanced autonomous AI agent design.

---

## 🏆 Core Creators & Maintainers

### 👑 **ripsnortntear (OldsmarChaos)**
* **Role:** Project Lead, Chief Architect & Quantitative Trader
* **Contributions:**
  * Core vision, strategy architecture, and domain modeling.
  * Quantitative trading heuristics (DCA cycle mechanics, fee shield protection logic, and dynamic capital absorption).
  * Production hardening, continuous integration testing, and live exchange validation on Coinbase Advanced Trade.
  * Repository stewardship and open-source release management.
* **GitHub:** [@ripsnortntear](https://github.com/ripsnortntear)

---

## 🤖 Autonomous AI Engineering Partner

### ⚡ **Antigravity (Google DeepMind)**
* **Role:** Autonomous AI Assistant & Core Systems Engineering
* **Contributions:**
  * **Zero-Dependency Architecture:** Designed the migration from external SQL engines to Node.js 22 built-in `node:sqlite`, eliminating database installations (no MariaDB/MySQL/PostgreSQL required).
  * **Cross-Platform Daemon Framework:** Authored universal automated setup wizards for Linux (`setup.sh`, systemd, OpenRC, standalone daemons) and Windows (`setup.bat`, `start.bat`, `stop.bat`, `status.bat`).
  * **Coinbase CDP Modernization:** Engineered the one-click `cdp_api_key.json` key importer and multi-line EC PEM private key parsing for Coinbase Cloud Developer Platform.
  * **Security & Encryption:** Implemented AES-256-GCM symmetric encryption for credential storage, Scrypt password hashing with random cryptographic salts, and signed session management.
  * **Reverse Proxy Orchestration:** Developed Apache 2.4 (`mod_proxy_wstunnel`) and Nginx WebSocket proxy configurations for resilient subpath and domain routing.
  * **Documentation & Technical Wiki:** Authored comprehensive operational manuals, strategy guides, and system documentation.

---

## 📦 Upstream Technologies & Open Source Ecosystem

We gratefully acknowledge the creators and maintainers of the foundational open-source libraries that make this engine possible:

* **[Coinbase Developer Platform (CDP)](https://portal.cdp.coinbase.com/):** For their robust Advanced Trade REST and WebSocket APIs.
* **[CCXT (CryptoCurrency eXchange Trading Library)](https://github.com/ccxt/ccxt):** The standard in multi-exchange algorithmic trading interfaces.
* **[Node.js](https://nodejs.org/):** For cutting-edge native features, specifically the high-performance native `node:sqlite` database module in v22+.
* **[Express](https://expressjs.com/):** Embedded high-throughput HTTP REST engine.
* **[ws](https://github.com/websockets/ws):** High-speed WebSockets for live order books and price ticker feeds.
* **[TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/):** Real-time interactive candlestick rendering.
* **[TypeScript](https://www.typescriptlang.org/):** Providing type safety and structural guarantees across the entire trading pipeline.

---

## 💬 Contributing
Contributions, bug reports, and feature requests are welcome! Please feel free to check the [Issues page](https://github.com/ripsnortntear/Coinbase_Crypto_Bot/issues) or submit pull requests.
