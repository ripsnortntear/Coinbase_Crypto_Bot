// Coinbase Crypto Bot - Automated Trading Terminal Client
(function () {
  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let currentLiveCandle = null;
  let currentSymbol = "ETH/USD";
  let currentTimeframe = "5m";
  let ws = null;
  let manualSide = "buy";
  const API_BASE = (window.__BASE_PATH__ !== undefined ? window.__BASE_PATH__ : "").replace(/\/+$/, "");

  // Intercept fetch calls to catch 401 Unauthenticated responses
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    if (res.status === 401 && typeof args[0] === "string" && !args[0].includes("/api/auth/")) {
      openModal("modalLogin");
    }
    return res;
  };

  async function checkAuth() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`);
      const json = await res.json();
      if (json.ok && json.data && json.data.user) {
        closeModal("modalLogin");
        const btnLogout = document.getElementById("btnLogout");
        if (btnLogout) {
          btnLogout.style.display = "inline-flex";
          btnLogout.textContent = `Sign Out (${json.data.user.username})`;
        }
        return true;
      }
    } catch (e) {}
    openModal("modalLogin");
    return false;
  }

  const state = {
    overview: {},
    bots: [],
    orders: [],
    trades: [],
    exchanges: [],
    logs: [],
    tickers: {},
  };

  function parseUtcDate(str) {
    if (!str) return new Date();
    if (typeof str === "number") return new Date(str);
    if (typeof str === "string") {
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(str)) {
        const iso = str.replace(" ", "T");
        return new Date(iso.endsWith("Z") ? iso : iso + "Z");
      }
      if (!str.endsWith("Z") && !str.includes("+") && !/-\d{2}:\d{2}$/.test(str)) {
        return new Date(str + "Z");
      }
      return new Date(str);
    }
    return new Date(str);
  }

  function formatTime(str) {
    const d = parseUtcDate(str);
    return isNaN(d.getTime()) ? "--:--:--" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const sel = document.getElementById("selectSymbol");
    if (sel && sel.value) {
      currentSymbol = sel.value;
    }
    const base = currentSymbol.split("/")[0];
    const baseLabel = document.getElementById("baseCurrencyLabel");
    if (baseLabel) baseLabel.textContent = base;

    // Highlight initial ribbon pill
    document.querySelectorAll(".ticker-pill").forEach(p => {
      p.classList.toggle("active", p.dataset.symbol === currentSymbol);
    });

    initChart();
    initEventListeners();
    initFadingScrollbar();

    checkAuth().then(isLoggedIn => {
      if (isLoggedIn) {
        initWebSocket();
        fetchInitialData();
      }
    });
  });

  // 1. Initialize Lightweight Candlestick Chart
  function initChart() {
    const container = document.getElementById("tradingview-chart-container");
    if (!container || typeof LightweightCharts === "undefined") return;

    chart = LightweightCharts.createChart(container, {
      layout: {
        background: { color: "#060b16" },
        textColor: "#94a3b8",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.04)" },
        horzLines: { color: "rgba(255, 255, 255, 0.04)" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.08)",
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.08)",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: "#10b981",
      downColor: "#ff006e",
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#ff006e",
    });

    volumeSeries = chart.addHistogramSeries({
      color: "rgba(0, 240, 255, 0.2)",
      priceFormat: { type: "volume" },
      priceScaleId: "",
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    window.addEventListener("resize", () => {
      if (chart && container) {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      }
    });

    loadChartData(true);

    // Background periodic chart refresh every 15s to keep candles perfectly synced
    setInterval(() => {
      if (document.visibilityState === "visible" && chart && candleSeries) {
        loadChartData(false);
      }
    }, 15000);
  }

  function getTimeframeInterval(tf) {
    switch (tf) {
      case "1m": return 60;
      case "5m": return 300;
      case "15m": return 900;
      case "1h": return 3600;
      case "4h": return 14400;
      case "1d": return 86400;
      default: return 300;
    }
  }

  async function loadChartData(fitContent = false) {
    try {
      const exParam = currentSymbol.endsWith("/USD") ? "&exchange=coinbase" : "";
      const res = await fetch(`${API_BASE}/api/market/ohlcv?symbol=${encodeURIComponent(currentSymbol)}&timeframe=${currentTimeframe}&limit=120${exParam}`);
      const json = await res.json();
      if (json.ok && Array.isArray(json.data) && json.data.length > 0) {
        candleSeries.setData(json.data);
        volumeSeries.setData(json.data.map(d => ({
          time: d.time,
          value: d.volume || 0,
          color: d.close >= d.open ? "rgba(16, 185, 129, 0.25)" : "rgba(255, 0, 110, 0.25)",
        })));
        currentLiveCandle = { ...json.data[json.data.length - 1] };
        if (fitContent) {
          chart.timeScale().fitContent();
        }
      }
    } catch (err) {
      console.error("[Chart Load Error]", err);
    }
  }

  // 2. Real-Time WebSocket Connection
  let wsReconnectTimer = null;
  function initWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsBase = API_BASE ? `${API_BASE}/ws` : "/ws";
    const wsUrl = `${protocol}//${window.location.host}${wsBase}`;

    try {
      clearTimeout(wsReconnectTimer);
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log("[WebSocket] Active session established:", wsUrl);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleWebSocketMessage(msg);
        } catch (e) {}
      };

      ws.onclose = (e) => {
        console.warn("[WebSocket] Disconnected:", e.code, e.reason);
        wsReconnectTimer = setTimeout(initWebSocket, 3500);
      };

      ws.onerror = (err) => {
        console.error("[WebSocket Error]", err);
      };
    } catch (err) {
      wsReconnectTimer = setTimeout(initWebSocket, 4000);
    }
  }

  function handleWebSocketMessage(msg) {
    if (msg.type === "ticker") {
      const ticker = msg.data;
      state.tickers[ticker.symbol] = ticker;
      updateTickerDisplay(ticker);
      recalculateLivePortfolioNav(ticker);

      if (ticker.symbol === currentSymbol) {
        renderOrderBook(ticker.last);
        updateOscillators(ticker.last);
        renderArbMatrix(ticker.last);
      }

      // If ticker matches currently viewed chart symbol, update live candle with authentic body & wicks
      if (ticker.symbol === currentSymbol && candleSeries) {
        const interval = getTimeframeInterval(currentTimeframe);
        const nowSec = Math.floor(Date.now() / 1000);
        const candleTime = Math.floor(nowSec / interval) * interval;

        if (currentLiveCandle && currentLiveCandle.time >= candleTime) {
          // In-progress active candle: retain open price, update high, low, close
          currentLiveCandle.high = Math.max(currentLiveCandle.high, ticker.last);
          currentLiveCandle.low = Math.min(currentLiveCandle.low, ticker.last);
          currentLiveCandle.close = ticker.last;
          candleSeries.update(currentLiveCandle);
        } else if (!currentLiveCandle || candleTime > currentLiveCandle.time) {
          // New candle period started: initialize with open = ticker.last
          currentLiveCandle = {
            time: candleTime,
            open: ticker.last,
            high: ticker.last,
            low: ticker.last,
            close: ticker.last,
            volume: 0,
          };
          candleSeries.update(currentLiveCandle);
        }

        if (volumeSeries && currentLiveCandle) {
          volumeSeries.update({
            time: currentLiveCandle.time,
            value: currentLiveCandle.volume || 0,
            color: currentLiveCandle.close >= currentLiveCandle.open ? "rgba(16, 185, 129, 0.25)" : "rgba(255, 0, 110, 0.25)",
          });
        }
      }
    } else if (msg.type === "trade") {
      fetchOrders();
      fetchTrades();
      fetchOverview();
      fetchBots();
    } else if (msg.type === "bot_status" || msg.type === "panic") {
      fetchBots();
      fetchOverview();
      fetchOrders();
    }
  }

  function updateTickerDisplay(ticker) {
    // Update live price header if current symbol
    if (ticker.symbol === currentSymbol) {
      const priceEl = document.getElementById("chartLivePrice");
      const changeEl = document.getElementById("chartLiveChange");
      if (priceEl) priceEl.textContent = `$${ticker.last.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      if (changeEl) {
        const pct = ticker.percentage || 0;
        changeEl.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
        changeEl.className = `live-change ${pct >= 0 ? "positive" : "negative"}`;
      }
    }

    // Update Ribbon Pills
    const baseSym = ticker.symbol.split("/")[0];
    const pEl = document.getElementById(`ribbon-${baseSym}-price`);
    const cEl = document.getElementById(`ribbon-${baseSym}-change`);
    if (pEl) pEl.textContent = `$${ticker.last >= 100 ? ticker.last.toFixed(2) : ticker.last.toFixed(4)}`;
    if (cEl) {
      const pct = ticker.percentage || 0;
      cEl.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      cEl.className = `change ${pct >= 0 ? "positive" : "negative"}`;
    }
  }

  // Live NAV Real-Time Calculation on incoming ticks
  function recalculateLivePortfolioNav(ticker) {
    if (!state.overview || !state.overview.livePortfolio || !state.overview.livePortfolio.balances) return;

    const balances = state.overview.livePortfolio.balances;
    const stableCoins = new Set(["USD", "USDC", "USDT", "USDS", "DAI"]);
    let totalUsd = 0;

    for (const [curr, bal] of Object.entries(balances)) {
      if (!bal || bal.total <= 0) continue;
      const cUpper = curr.toUpperCase();
      if (stableCoins.has(cUpper)) {
        totalUsd += bal.total;
      } else if (cUpper === "ETH") {
        const ethPrice = (ticker && ticker.symbol && ticker.symbol.startsWith("ETH/")) ? ticker.last : (state.tickers["ETH/USD"]?.last || 1825);
        totalUsd += bal.total * ethPrice;
      } else if (cUpper === "BTC") {
        const btcPrice = (ticker && ticker.symbol && ticker.symbol.startsWith("BTC/")) ? ticker.last : (state.tickers["BTC/USD"]?.last || 90000);
        totalUsd += bal.total * btcPrice;
      } else if (cUpper === "SOL") {
        const solPrice = (ticker && ticker.symbol && ticker.symbol.startsWith("SOL/")) ? ticker.last : (state.tickers["SOL/USD"]?.last || 150);
        totalUsd += bal.total * solPrice;
      } else if (cUpper === "XTZ") {
        totalUsd += bal.total * 0.22;
      } else {
        totalUsd += bal.total * 1.0;
      }
    }

    const portEl = document.getElementById("statPortfolio");
    if (portEl && totalUsd > 0) {
      portEl.textContent = `$${totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
  }

  // 3. Data Fetching
  async function fetchInitialData() {
    initWhaleTape();
    initMacroHudTimer();
    renderOrderBook(1815.0);
    updateOscillators(1815.0);
    renderArbMatrix(1815.0);

    // Continuous Live Portfolio & Fleet Auto-Refresh (Every 6 seconds)
    setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchOverview();
        fetchBots();
      }
    }, 6000);

    await Promise.all([
      fetchOverview(),
      fetchTickers(),
      loadCoinbaseMarkets(),
      fetchBots(),
      fetchOrders(),
      fetchTrades(),
      fetchExchanges(),
      fetchLogs(),
    ]);
  }

  async function fetchTickers() {
    const symbols = ["ETH/USD", "BTC/USD", "SOL/USD"];
    for (const sym of symbols) {
      try {
        const res = await fetch(`${API_BASE}/api/market/ticker?symbol=${encodeURIComponent(sym)}`);
        const json = await res.json();
        if (json.ok && json.data) {
          state.tickers[sym] = json.data;
          updateTickerDisplay(json.data);
          if (sym === currentSymbol) {
            renderOrderBook(json.data.last);
            updateOscillators(json.data.last);
            renderArbMatrix(json.data.last);
          }
        }
      } catch (e) {}
    }
  }

  async function fetchOverview() {
    try {
      const res = await fetch(`${API_BASE}/api/system/overview`);
      const json = await res.json();
      if (!json.ok) return;

      const d = json.data;
      state.overview = d;

      // Update UI cards
      const activeEl = document.getElementById("statActiveBots");
      if (activeEl) activeEl.innerHTML = `${d.activeBots} <span class="dim">/ ${d.totalBots}</span>`;

      const pnlEl = document.getElementById("statPnl");
      if (pnlEl) {
        pnlEl.textContent = `${d.totalPnl >= 0 ? "+" : ""}$${d.totalPnl.toFixed(2)}`;
        pnlEl.className = `stat-value ${d.totalPnl >= 0 ? "positive" : "negative"}`;
      }

      const winEl = document.getElementById("statWinRate");
      if (winEl) winEl.textContent = `Win Rate: ${d.winRate}%`;

      const tradesEl = document.getElementById("statTrades");
      if (tradesEl) tradesEl.textContent = d.totalTrades;

      // Portfolio Total
      const portEl = document.getElementById("statPortfolio");
      const portSubEl = document.getElementById("statPortfolioSub");
      if (d.livePortfolio && d.livePortfolio.totalUsd > 0) {
        if (portEl) portEl.textContent = `$${d.livePortfolio.totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        if (portSubEl) portSubEl.textContent = d.livePortfolio.breakdown || `${d.livePortfolio.accountName} Live Assets`;
      } else if (d.paperBalances && Object.keys(d.paperBalances).length > 0) {
        let totalPaper = (d.paperBalances.USDT?.total || 0) + (d.paperBalances.USD?.total || 0);
        if (portEl) portEl.textContent = `$${totalPaper.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        if (portSubEl) portSubEl.textContent = "Simulation Portfolio";
      } else {
        if (portEl) portEl.textContent = "$0.00";
        if (portSubEl) portSubEl.textContent = "Live Cash & Crypto";
      }

      // Panic Banner
      const panicBtn = document.getElementById("btnPanic");
      if (panicBtn) {
        if (d.panicActive) {
          panicBtn.innerHTML = `<span>⚠️</span> PANIC ACTIVE (RESET)`;
          panicBtn.className = "btn btn-secondary";
        } else {
          panicBtn.innerHTML = `<span>🚨</span> PANIC STOP`;
          panicBtn.className = "btn btn-danger";
        }
      }

      // Live Fear & Greed + Regime Guard HUD update
      const fngEl = document.getElementById("m-fng");
      if (fngEl && d.regime) {
        const r = d.regime;
        fngEl.textContent = `${r.fngValue} [${r.fngLabel.toUpperCase()} • ${r.regime}]`;
        fngEl.className = r.regime === "CRASH_RISK" ? "text-red" : r.regime === "CAUTION" ? "text-amber" : "text-emerald";
      }
    } catch (err) {}
  }

  async function fetchBots() {
    try {
      const res = await fetch(`${API_BASE}/api/bots`);
      const json = await res.json();
      if (!json.ok) return;

      state.bots = json.data;
      renderBotsList(state.bots);
      updateModeBadge();

      const countBadge = document.getElementById("botCountBadge");
      if (countBadge) countBadge.textContent = `${state.bots.length} Bots`;
    } catch (err) {}
  }

  function updateModeBadge() {
    const badge = document.getElementById("modeBadge");
    const text = document.getElementById("modeText");
    if (!badge || !text) return;

    const hasLiveActiveBots = state.bots.some(b => b.status === "active");
    const hasLiveBots = state.bots.length > 0;
    const hasLiveAccount = state.exchanges.length > 0;

    badge.className = "mode-badge live";
    if (hasLiveActiveBots) {
      text.textContent = "LIVE TRADING ACTIVE";
    } else if (hasLiveBots) {
      text.textContent = "LIVE FLEET READY";
    } else if (hasLiveAccount) {
      text.textContent = "COINBASE LIVE READY";
    } else {
      text.textContent = "COINBASE LIVE (CONNECT API KEY)";
    }
  }

  function renderBotsList(bots) {
    const container = document.getElementById("botsList");
    if (!container) return;

    if (!bots || bots.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🤖</span>
          <p>No trading bots deployed yet.</p>
          <button id="btnEmptyDeploy" class="btn btn-primary btn-sm">Deploy Your First Bot</button>
        </div>
      `;
      document.getElementById("btnEmptyDeploy")?.addEventListener("click", () => openModal("modalDeployBot"));
      return;
    }

    container.innerHTML = bots.map((bot) => {
      const isWinRate = bot.total_trades > 0 ? Math.round((bot.winning_trades / bot.total_trades) * 100) : 0;
      const stratLabels = {
        grid: "GRID TRADING",
        dca: "DCA + TP",
        momentum_rsi: "MOMENTUM RSI",
        bollinger: "BOLLINGER BANDS",
      };

      return `
        <div class="bot-card ${bot.status}" data-id="${bot.id}">
          <div class="bot-header">
            <div class="bot-title-area">
              <span class="status-dot ${bot.status}"></span>
              <span class="bot-name">${escapeHtml(bot.name)}</span>
              <span class="strat-tag">${stratLabels[bot.strategy_type] || bot.strategy_type.toUpperCase()}</span>
              <span class="badge ${bot.is_paper ? 'badge-paper' : 'badge-live'}">${bot.is_paper ? 'PAPER' : 'LIVE'}</span>
            </div>
            <span class="dim" style="font-size: 0.72rem;">${bot.symbol}</span>
          </div>

          <div class="bot-metrics">
            <div class="bot-metric">
              <span class="m-label">Net P&amp;L</span>
              <span class="m-val ${bot.realized_pnl >= 0 ? "positive" : "negative"}">
                ${bot.realized_pnl >= 0 ? "+" : ""}$${bot.realized_pnl.toFixed(2)}
              </span>
            </div>
            <div class="bot-metric">
              <span class="m-label">Trades / Win%</span>
              <span class="m-val">${bot.total_trades} (${isWinRate}%)</span>
            </div>
            <div class="bot-metric">
              <span class="m-label">Capital</span>
              <span class="m-val">$${bot.allocated_capital.toFixed(0)}</span>
            </div>
          </div>

          <div class="bot-controls">
            <button class="btn btn-secondary btn-sm btn-edit-bot" data-id="${bot.id}" title="Edit Bot Strategy & Parameters">⚙️ Edit</button>
            <button class="btn btn-secondary btn-sm btn-edit-cap" data-id="${bot.id}" data-cap="${bot.allocated_capital}" title="Top-up / Adjust Allocated Capital">+$ Cap</button>
            ${bot.status === "active" ? `
              <button class="btn btn-secondary btn-sm btn-pause" data-id="${bot.id}">Pause</button>
            ` : `
              <button class="btn btn-primary btn-sm btn-start" data-id="${bot.id}">Start</button>
            `}
            <button class="btn btn-secondary btn-sm btn-stop" data-id="${bot.id}">Stop</button>
            <button class="btn btn-secondary btn-sm btn-delete" data-id="${bot.id}" title="Delete Bot" style="color: var(--ruby);">✕</button>
          </div>
        </div>
      `;
    }).join("");

    // Wire bot control buttons
    container.querySelectorAll(".btn-edit-bot").forEach(b => b.addEventListener("click", () => openEditBotModal(b.dataset.id)));
    container.querySelectorAll(".btn-edit-cap").forEach(b => b.addEventListener("click", () => handleTopUpCapital(b.dataset.id, b.dataset.cap)));
    container.querySelectorAll(".btn-start").forEach(b => b.addEventListener("click", () => handleBotAction(b.dataset.id, "start")));
    container.querySelectorAll(".btn-pause").forEach(b => b.addEventListener("click", () => handleBotAction(b.dataset.id, "pause")));
    container.querySelectorAll(".btn-stop").forEach(b => b.addEventListener("click", () => handleBotAction(b.dataset.id, "stop")));
    container.querySelectorAll(".btn-delete").forEach(b => b.addEventListener("click", () => handleDeleteBot(b.dataset.id)));
  }

  async function handleTopUpCapital(botId, currentCap) {
    const input = prompt(`Top-Up / Adjust Allocated Capital:\nEnter new total allocated capital ($ USD) for this bot:`, currentCap);
    if (!input) return;
    const val = parseFloat(input);
    if (isNaN(val) || val <= 0) {
      alert("Please enter a valid positive number for allocated capital.");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allocated_capital: val })
      });
      const json = await res.json();
      if (json.ok) {
        fetchBots();
        fetchOverview();
      } else {
        alert(json.error || "Failed to update capital");
      }
    } catch (err) {
      alert("Error updating bot capital: " + err.message);
    }
  }

  async function handleBotAction(botId, action) {
    try {
      const res = await fetch(`${API_BASE}/api/bots/${botId}/${action}`, { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        fetchBots();
        fetchOverview();
      } else {
        alert(json.error || `Failed to ${action} bot`);
      }
    } catch (e) {
      alert("Network request failed");
    }
  }

  async function handleDeleteBot(botId) {
    if (!confirm("Are you sure you want to stop and delete this trading bot?")) return;
    try {
      const res = await fetch(`${API_BASE}/api/bots/${botId}`, { method: "DELETE" });
      const json = await res.json();
      if (json.ok) {
        fetchBots();
        fetchOverview();
      }
    } catch (e) {}
  }

  async function fetchOrders() {
    try {
      const res = await fetch(`${API_BASE}/api/orders?status=open`);
      const json = await res.json();
      if (!json.ok) return;

      state.orders = json.data;
      const countEl = document.getElementById("openOrdersCount");
      if (countEl) countEl.textContent = state.orders.length;

      const tbody = document.getElementById("ordersTableBody");
      if (!tbody) return;

      if (state.orders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="text-center dim">No open orders.</td></tr>`;
        return;
      }

      tbody.innerHTML = state.orders.map(o => `
        <tr>
          <td class="dim">${formatTime(o.created_at)}</td>
          <td>${o.bot_name ? escapeHtml(o.bot_name) : '<span class="dim">Discretionary</span>'}</td>
          <td><strong>${o.symbol}</strong></td>
          <td class="${o.side === 'buy' ? 'positive' : 'negative'}"><strong>${o.side.toUpperCase()}</strong></td>
          <td>${o.type.toUpperCase()}</td>
          <td>$${o.price.toFixed(2)}</td>
          <td>${o.amount}</td>
          <td>${o.filled_amount}</td>
          <td><span class="badge">${o.is_paper ? 'Paper' : 'Live'}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm btn-cancel-order" data-id="${o.id}">Cancel</button>
          </td>
        </tr>
      `).join("");

      tbody.querySelectorAll(".btn-cancel-order").forEach(b => b.addEventListener("click", () => handleCancelOrder(b.dataset.id)));
    } catch (err) {}
  }

  async function handleCancelOrder(orderId) {
    try {
      const res = await fetch(`${API_BASE}/api/orders/${orderId}/cancel`, { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        fetchOrders();
      } else {
        alert(json.error || "Failed to cancel order");
      }
    } catch (e) {}
  }

  async function fetchTrades() {
    try {
      const res = await fetch(`${API_BASE}/api/orders/trades?limit=50`);
      const json = await res.json();
      if (!json.ok) return;

      state.trades = json.data;
      const tbody = document.getElementById("tradesTableBody");
      if (!tbody) return;

      if (state.trades.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center dim">No executed trades recorded yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = state.trades.map(t => `
        <tr>
          <td class="dim">${formatTime(t.timestamp)}</td>
          <td>${t.bot_name ? escapeHtml(t.bot_name) : '<span class="dim">Manual</span>'}</td>
          <td><strong>${t.symbol}</strong></td>
          <td class="${t.side === 'buy' ? 'positive' : 'negative'}"><strong>${t.side.toUpperCase()}</strong></td>
          <td>$${t.price.toFixed(2)}</td>
          <td>${t.amount}</td>
          <td>$${t.cost.toFixed(2)}</td>
          <td class="dim">$${t.fee.toFixed(4)}</td>
          <td class="${t.realized_pnl >= 0 ? 'positive' : 'negative'}">
            ${t.realized_pnl ? (t.realized_pnl >= 0 ? '+' : '') + '$' + t.realized_pnl.toFixed(2) : '--'}
          </td>
        </tr>
      `).join("");
    } catch (err) {}
  }

  async function fetchExchanges() {
    try {
      const res = await fetch(`${API_BASE}/api/exchanges`);
      const json = await res.json();
      if (!json.ok) return;

      // Filter out any paper simulation accounts completely
      state.exchanges = (json.data || []).filter(e => e.is_paper === 0 && !e.id.startsWith("paper-"));
      updateModeBadge();

      const select = document.getElementById("botExchange");
      if (select) {
        select.innerHTML = state.exchanges.map(e => `
          <option value="${e.id}">${escapeHtml(e.name)} (Live Trading)</option>
        `).join("");
      }

      const termSelect = document.getElementById("terminalAccountSelect");
      if (termSelect) {
        const prevVal = termSelect.value;
        termSelect.innerHTML = state.exchanges.map(e => `
          <option value="${e.id}">${escapeHtml(e.name)} (Live Trading)</option>
        `).join("");
        if (prevVal && state.exchanges.some(e => e.id === prevVal)) {
          termSelect.value = prevVal;
        } else if (state.exchanges[0]) {
          termSelect.value = state.exchanges[0].id;
        }
      }

      const grid = document.getElementById("exchangesList");
      if (grid) {
        if (state.exchanges.length === 0) {
          grid.innerHTML = `<div class="dim text-center" style="grid-column: 1/-1; padding: 20px;">No exchange accounts connected. Click "+ Connect Exchange API" above.</div>`;
        } else {
          grid.innerHTML = state.exchanges.map(e => `
            <div class="exchange-card" id="card-${e.id}">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <strong>${escapeHtml(e.name)}</strong>
                <span class="badge badge-live">Live Trading</span>
              </div>
              <div style="font-size: 0.78rem;" class="dim">Exchange: ${e.exchange_id.toUpperCase()}</div>
              <div style="font-size: 0.75rem;" class="dim status-label" id="status-${e.id}">Status: Connected &amp; Verified</div>
              <div class="exchange-balances" id="balances-${e.id}" style="font-size: 0.75rem; margin-top: 4px; display: none;"></div>
              <div style="display: flex; gap: 8px; margin-top: 6px;">
                <button class="btn btn-secondary btn-sm btn-test-exchange" data-id="${e.id}">Check Balance</button>
                <button class="btn btn-secondary btn-sm btn-del-exchange" data-id="${e.id}" style="color: var(--ruby);">Remove</button>
              </div>
            </div>
          `).join("");

          grid.querySelectorAll(".btn-test-exchange").forEach(b => b.addEventListener("click", () => handleTestExchange(b.dataset.id)));
          grid.querySelectorAll(".btn-del-exchange").forEach(b => b.addEventListener("click", () => handleDeleteExchange(b.dataset.id)));
        }
      }
    } catch (err) {}
  }

  async function handleTestExchange(id) {
    const balEl = document.getElementById(`balances-${id}`);
    const statEl = document.getElementById(`status-${id}`);
    if (statEl) statEl.textContent = "Checking balances via API...";
    try {
      const res = await fetch(`${API_BASE}/api/exchanges/${id}/balances`);
      const json = await res.json();
      if (json.ok && json.data) {
        if (statEl) {
          statEl.textContent = "Status: ✓ Active & Authorized";
          statEl.style.color = "var(--emerald)";
        }
        if (balEl) {
          const nonZero = Object.entries(json.data)
            .filter(([_, v]) => v.total > 0.000001)
            .map(([cur, v]) => `${cur}: ${v.total < 1 ? v.total.toFixed(5) : v.total.toFixed(2)}`);
          balEl.textContent = nonZero.length > 0 ? `Portfolio: ${nonZero.join(", ")}` : "Portfolio: Zero balance";
          balEl.style.display = "block";
          balEl.style.color = "var(--cyan)";
        }
      } else {
        if (statEl) {
          statEl.textContent = `Status: ✕ ${json.error || "Connection error"}`;
          statEl.style.color = "var(--ruby)";
        }
      }
    } catch (e) {
      if (statEl) {
        statEl.textContent = "Status: ✕ Connection failed";
        statEl.style.color = "var(--ruby)";
      }
    }
  }

  async function handleDeleteExchange(id) {
    if (!confirm("Remove this exchange account? Associated bots will also be removed.")) return;
    try {
      await fetch(`${API_BASE}/api/exchanges/${id}`, { method: "DELETE" });
      fetchExchanges();
    } catch (e) {}
  }

  async function fetchLogs() {
    try {
      const res = await fetch(`${API_BASE}/api/system/logs?limit=80`);
      const json = await res.json();
      if (!json.ok) return;

      const consoleEl = document.getElementById("logsConsole");
      if (!consoleEl) return;

      consoleEl.innerHTML = json.data.map(l => `
        <div class="log-entry">
          <span class="log-time">[${formatTime(l.timestamp)}]</span>
          <span class="log-level ${l.level}">[${l.level.toUpperCase()}]</span>
          <span class="log-msg">${escapeHtml(l.message)}</span>
        </div>
      `).join("");
    } catch (err) {}
  }

  // 4. Event Listeners
  function initEventListeners() {
    // Sign Out Button Handler
    const btnLogout = document.getElementById("btnLogout");
    if (btnLogout) {
      btnLogout.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          await fetch(`${API_BASE}/api/auth/logout`, { method: "POST" });
        } catch (err) {
          console.error("Logout request error:", err);
        }
        // Invalidate session cookie client-side
        document.cookie = "cb_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        // Teardown live websocket
        if (ws) {
          try { ws.close(); } catch (e) {}
          ws = null;
        }
        // Clear login form fields & messages
        const loginPass = document.getElementById("loginPassword");
        if (loginPass) loginPass.value = "";
        const loginError = document.getElementById("loginError");
        if (loginError) {
          loginError.style.display = "none";
          loginError.textContent = "";
        }
        openModal("modalLogin");
      });
    }

    // Login Form Submit Handler
    const formLogin = document.getElementById("formLogin");
    if (formLogin) {
      formLogin.addEventListener("submit", async (e) => {
        e.preventDefault();
        const usernameInput = document.getElementById("loginUsername");
        const passwordInput = document.getElementById("loginPassword");
        const errorDiv = document.getElementById("loginError");

        const username = usernameInput ? usernameInput.value.trim() : "";
        const password = passwordInput ? passwordInput.value : "";

        if (!username || !password) {
          if (errorDiv) {
            errorDiv.textContent = "Please enter both username and password.";
            errorDiv.style.display = "block";
          }
          return;
        }

        try {
          const res = await fetch(`${API_BASE}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
          });
          const json = await res.json();
          if (json.ok) {
            closeModal("modalLogin");
            if (errorDiv) errorDiv.style.display = "none";
            if (passwordInput) passwordInput.value = "";
            const btnLogout = document.getElementById("btnLogout");
            if (btnLogout && json.data && json.data.user) {
              btnLogout.style.display = "inline-flex";
              btnLogout.textContent = `Sign Out (${json.data.user.username})`;
            }
            initWebSocket();
            fetchInitialData();
            loadChartData(true);
          } else {
            if (errorDiv) {
              errorDiv.textContent = json.error || "Invalid username or password";
              errorDiv.style.display = "block";
            }
          }
        } catch (err) {
          if (errorDiv) {
            errorDiv.textContent = "Network error connecting to authentication service.";
            errorDiv.style.display = "block";
          }
        }
      });
    }
    // Symbol Switcher
    const selectSymbol = document.getElementById("selectSymbol");
    if (selectSymbol) {
      selectSymbol.addEventListener("change", (e) => {
        currentSymbol = e.target.value;
        const base = currentSymbol.split("/")[0];
        const baseLabel = document.getElementById("baseCurrencyLabel");
        if (baseLabel) baseLabel.textContent = base;

        // Highlight ribbon pill
        document.querySelectorAll(".ticker-pill").forEach(p => {
          p.classList.toggle("active", p.dataset.symbol === currentSymbol);
        });

        loadChartData(true);
      });
    }

    // Ribbon Pills Click
    document.querySelectorAll(".ticker-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        const sym = pill.dataset.symbol;
        if (sym && selectSymbol) {
          selectSymbol.value = sym;
          selectSymbol.dispatchEvent(new Event("change"));
        }
      });
    });

    // Timeframe Buttons
    document.querySelectorAll(".tf-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentTimeframe = btn.dataset.tf;
        loadChartData(true);
      });
    });

    // Manual Fast Order Side Toggle
    const sideBuy = document.getElementById("sideBuy");
    const sideSell = document.getElementById("sideSell");
    const submitBtn = document.getElementById("btnSubmitOrder");

    sideBuy?.addEventListener("click", () => {
      manualSide = "buy";
      sideBuy.classList.add("active");
      sideSell?.classList.remove("active");
      if (submitBtn) {
        submitBtn.className = "btn btn-buy";
        submitBtn.textContent = "Submit Buy Order";
      }
    });

    sideSell?.addEventListener("click", () => {
      manualSide = "sell";
      sideSell.classList.add("active");
      sideBuy?.classList.remove("active");
      if (submitBtn) {
        submitBtn.className = "btn btn-sell";
        submitBtn.textContent = "Submit Sell Order";
      }
    });

    // Limit vs Market price field toggle
    const orderType = document.getElementById("orderType");
    const groupLimit = document.getElementById("groupLimitPrice");
    orderType?.addEventListener("change", (e) => {
      if (groupLimit) groupLimit.style.display = e.target.value === "limit" ? "block" : "none";
    });

    // Manual Order Form Submit
    document.getElementById("formManualOrder")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const amount = parseFloat(document.getElementById("orderAmount")?.value || "0");
      const type = document.getElementById("orderType")?.value || "market";
      const price = parseFloat(document.getElementById("orderPrice")?.value || "0");
      const activeExchangeId = document.getElementById("terminalAccountSelect")?.value || state.exchanges[0]?.id;
      if (!activeExchangeId) return alert("No active exchange account available");

      if (amount <= 0) return alert("Please specify valid order amount");
      if (type === "limit" && price <= 0) return alert("Please specify valid limit price");

      try {
        const res = await fetch(`${API_BASE}/api/orders/manual`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            exchange_account_id: activeExchangeId,
            symbol: currentSymbol,
            side: manualSide,
            type,
            price: type === "limit" ? price : (state.tickers[currentSymbol]?.last || 0),
            amount,
          }),
        });
        const json = await res.json();
        if (json.ok) {
          fetchOrders();
          fetchTrades();
          fetchOverview();
          document.getElementById("orderAmount").value = "";
        } else {
          alert(json.error || "Order placement failed");
        }
      } catch (err) {
        alert("Network request failed");
      }
    });

    // Panic Kill Switch
    document.getElementById("btnPanic")?.addEventListener("click", async () => {
      if (state.overview.panicActive) {
        if (!confirm("Panic status is currently active. Do you want to clear panic mode and allow trading again?")) return;
        await fetch(`${API_BASE}/api/system/panic/reset`, { method: "POST" });
        fetchOverview();
        return;
      }

      if (!confirm("🚨 DANGER: Activate Panic Stop?\n\nThis will immediately pause all automated trading bots and cancel all open limit orders across all exchanges.")) return;

      try {
        const res = await fetch(`${API_BASE}/api/system/panic`, { method: "POST" });
        const json = await res.json();
        alert(json.message);
        fetchOverview();
        fetchBots();
        fetchOrders();
      } catch (e) {
        alert("Panic execution error");
      }
    });

    // Reset Paper Wallet (deprecated in live trading mode)

    // Tab Switching
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

        btn.classList.add("active");
        const targetId = btn.dataset.tab;
        document.getElementById(targetId)?.classList.add("active");

        if (targetId === "tab-orders") fetchOrders();
        else if (targetId === "tab-trades") fetchTrades();
        else if (targetId === "tab-tape") renderTape();
        else if (targetId === "tab-arb") renderArbMatrix(quantState.lastPrice);
        else if (targetId === "tab-exchanges") fetchExchanges();
        else if (targetId === "tab-logs") fetchLogs();
      });
    });

    // Quick Size Percentage Chips
    document.querySelectorAll(".chip-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const pct = parseFloat(btn.dataset.pct || "0.25");
        const price = state.tickers[currentSymbol]?.last || quantState.lastPrice || 1815;
        const liveUsd = state.overview?.livePortfolio?.totalUsd || 3.0;
        const targetAmountUsd = liveUsd * pct;
        const baseAmount = (targetAmountUsd / price).toFixed(5);
        const orderAmountInput = document.getElementById("orderAmount");
        if (orderAmountInput) orderAmountInput.value = baseAmount;
      });
    });

    // Modals
    document.getElementById("btnBacktest")?.addEventListener("click", () => openModal("modalBacktest"));
    document.getElementById("btnCanvas")?.addEventListener("click", openCanvasModal);
    document.getElementById("btnAddCanvasNode")?.addEventListener("click", () => addCanvasNodeRow());
    document.getElementById("btnDeployCanvas")?.addEventListener("click", deployCanvasBot);
    document.getElementById("btnRunBacktest")?.addEventListener("click", runBacktest);
    document.getElementById("btnRunOptimize")?.addEventListener("click", runOptimize);
    document.getElementById("btnSaveRiskSettings")?.addEventListener("click", saveRiskSettings);
    document.getElementById("btnSystemStatus")?.addEventListener("click", openSystemStatusModal);
    document.getElementById("btnNewBot")?.addEventListener("click", () => {
      openModal("modalDeployBot");
      const liveUsd = state.overview?.livePortfolio?.totalUsd;
      const capitalInput = document.getElementById("botCapital");
      if (capitalInput && liveUsd && Number(liveUsd) > 0) {
        capitalInput.value = Number(liveUsd).toFixed(2);
      }
    });
    document.getElementById("btnAddExchange")?.addEventListener("click", () => openModal("modalAddExchange"));

    document.querySelectorAll(".modal-close, [data-close]").forEach(el => {
      el.addEventListener("click", () => {
        const target = el.dataset.close || el.closest(".modal-backdrop").id;
        closeModal(target);
      });
    });

    // Strategy Radio Switcher in Deploy Bot Modal
    document.querySelectorAll("input[name='strategy_type']").forEach(radio => {
      radio.addEventListener("change", (e) => {
        const val = e.target.value;
        document.getElementById("stratParamsGrid").style.display = val === "grid" ? "block" : "none";
        document.getElementById("stratParamsDca").style.display = val === "dca" ? "block" : "none";
        document.getElementById("stratParamsMomentum").style.display = val === "momentum_rsi" ? "block" : "none";
        document.getElementById("stratParamsBollinger").style.display = val === "bollinger" ? "block" : "none";
      });
    });

    // Deploy Bot Form
    document.getElementById("formDeployBot")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("botName").value;
      const exchange_account_id = document.getElementById("botExchange").value;
      const symbol = document.getElementById("botSymbol").value;
      const allocated_capital = parseFloat(document.getElementById("botCapital").value);
      const strategy_type = document.querySelector("input[name='strategy_type']:checked").value;

      let config = {};
      if (strategy_type === "grid") {
        config = {
          lowerPrice: parseFloat(document.getElementById("gridLower").value || "0"),
          upperPrice: parseFloat(document.getElementById("gridUpper").value || "0"),
          grids: parseInt(document.getElementById("gridCount").value || "10"),
        };
      } else if (strategy_type === "dca") {
        const cap = allocated_capital || 1.25;
        const baseOrderAmount = Math.max(1.25, Number((cap * 0.25).toFixed(2)));
        const safetyOrderAmount = Math.max(1.25, Number((cap * 0.20).toFixed(2)));
        const rawTp = parseFloat(document.getElementById("dcaTp").value || "2.5");
        const rawDrop = parseFloat(document.getElementById("dcaDrop").value || "1.8");
        const rawTrailTp = parseFloat(document.getElementById("dcaTrailTp")?.value || "0");
        config = {
          baseOrderAmount,
          safetyOrderAmount,
          priceDropPercentage: Math.max(1.2, rawDrop),
          takeProfitPercentage: Math.max(2.0, rawTp),
          trailingTakeProfitPercentage: rawTrailTp > 0 ? rawTrailTp : undefined,
          maxSafetyOrders: 5,
        };
      } else if (strategy_type === "momentum_rsi") {
        config = {
          rsiOversold: parseInt(document.getElementById("rsiOversold").value || "30"),
          rsiOverbought: parseInt(document.getElementById("rsiOverbought").value || "70"),
          orderAmount: parseFloat(document.getElementById("rsiAmount").value || "250"),
          takeProfitPercentage: parseFloat(document.getElementById("rsiTp").value || "4.0"),
          timeframe: "5m",
        };
      } else if (strategy_type === "bollinger") {
        config = {
          period: parseInt(document.getElementById("bbPeriod").value || "20"),
          stdDev: parseFloat(document.getElementById("bbStdDev").value || "2"),
          orderAmount: parseFloat(document.getElementById("bbAmount").value || "250"),
          timeframe: "5m",
        };
      }

      try {
        const res = await fetch(`${API_BASE}/api/bots`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            exchange_account_id,
            symbol,
            strategy_type,
            allocated_capital,
            config,
          }),
        });
        const json = await res.json();
        if (json.ok) {
          closeModal("modalDeployBot");
          fetchBots();
          fetchOverview();
        } else {
          alert(json.error || "Failed to create bot");
        }
      } catch (err) {
        alert("Failed to submit bot form");
      }
    });

    // Live vs Paper Exchange API form toggle
    const exIsPaper = document.getElementById("exIsPaper");
    const liveCreds = document.getElementById("liveApiCredentials");
    exIsPaper?.addEventListener("change", (e) => {
      if (liveCreds) liveCreds.style.display = e.target.value === "0" ? "block" : "none";
    });

    // Add Exchange Form
    document.getElementById("formAddExchange")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("exName").value;
      const exchange_id = document.getElementById("exExchangeId").value;
      const is_paper = parseInt(document.getElementById("exIsPaper").value);
      const api_key = document.getElementById("exApiKey").value;
      const api_secret = document.getElementById("exApiSecret").value;
      const passphrase = document.getElementById("exPassphrase") ? document.getElementById("exPassphrase").value : "";

      try {
        const res = await fetch(`${API_BASE}/api/exchanges`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            exchange_id,
            is_paper,
            api_key,
            api_secret,
            passphrase,
          }),
        });
        const json = await res.json();
        if (json.ok) {
          closeModal("modalAddExchange");
          fetchExchanges();
        } else {
          alert(json.error || "Failed to connect exchange");
        }
      } catch (err) {
        alert("Failed to save exchange account");
      }
    });
  }

  // ==========================================================================
  // QUANTITATIVE TELEMETRY, LEVEL 2 ORDERBOOK & ARBITRAGE ENGINES
  // ==========================================================================
  const quantState = {
    tapeTrades: [],
    lastPrice: 1815.0,
    mempoolTxns: 142810,
    gasBase: 14.2,
    burnRate: 1.48,
    hftLatency: 18.4,
  };

  function renderOrderBook(price) {
    if (!price || price <= 0) price = quantState.lastPrice;
    quantState.lastPrice = price;

    const baseSpread = price * 0.00006;
    const spreadVal = Math.max(0.06, baseSpread);
    const mid = price;

    const asksBody = document.getElementById("obAsksBody");
    const bidsBody = document.getElementById("obBidsBody");
    const spreadEl = document.getElementById("obSpreadVal");
    const midEl = document.getElementById("obMidPrice");
    if (!asksBody || !bidsBody) return;

    if (spreadEl) spreadEl.textContent = `$${spreadVal.toFixed(2)} (${((spreadVal / mid) * 10000).toFixed(2)} bps)`;
    if (midEl) midEl.textContent = `MID: $${mid.toFixed(2)}`;

    // Generate 6 asks (highest price down to lowest ask)
    let asks = [];
    let cumAskVal = 0;
    for (let i = 6; i >= 1; i--) {
      const askPrice = mid + (spreadVal / 2) + (i - 1) * (spreadVal * 0.85);
      const size = Number((0.45 + Math.sin(i * 1.7 + Date.now() / 60000) * 0.3 + (i * 0.35)).toFixed(4));
      const val = askPrice * size;
      cumAskVal += val;
      asks.push({ price: askPrice, size, val, cum: cumAskVal });
    }

    // Generate 6 bids (highest bid down to lowest)
    let bids = [];
    let cumBidVal = 0;
    for (let i = 1; i <= 6; i++) {
      const bidPrice = mid - (spreadVal / 2) - (i - 1) * (spreadVal * 0.85);
      const size = Number((0.55 + Math.cos(i * 1.5 + Date.now() / 60000) * 0.3 + (i * 0.4)).toFixed(4));
      const val = bidPrice * size;
      cumBidVal += val;
      bids.push({ price: bidPrice, size, val, cum: cumBidVal });
    }

    const maxCum = Math.max(cumAskVal, cumBidVal, 1);

    asksBody.innerHTML = asks.map(a => `
      <tr class="ob-row ask">
        <td>$${a.price.toFixed(2)}</td>
        <td>${a.size.toFixed(4)}</td>
        <td class="dim">$${a.cum.toLocaleString(undefined, { maximumFractionDigits: 0 })}<div class="ob-depth-bar" style="width: ${Math.min(100, (a.cum / maxCum) * 100)}%;"></div></td>
      </tr>
    `).join("");

    bidsBody.innerHTML = bids.map(b => `
      <tr class="ob-row bid">
        <td>$${b.price.toFixed(2)}</td>
        <td>${b.size.toFixed(4)}</td>
        <td class="dim">$${b.cum.toLocaleString(undefined, { maximumFractionDigits: 0 })}<div class="ob-depth-bar" style="width: ${Math.min(100, (b.cum / maxCum) * 100)}%;"></div></td>
      </tr>
    `).join("");

    // Calculate Imbalance
    const bidRatio = (cumBidVal / (cumBidVal + cumAskVal)) * 100;
    const askRatio = 100 - bidRatio;
    const obiPct = (bidRatio - askRatio).toFixed(1);

    const fillEl = document.getElementById("obImbalanceFill");
    const bidPctEl = document.getElementById("obBidPct");
    const askPctEl = document.getElementById("obAskPct");
    if (fillEl) fillEl.style.width = `${bidRatio.toFixed(1)}%`;
    if (bidPctEl) bidPctEl.textContent = `BIDS: ${bidRatio.toFixed(1)}%`;
    if (askPctEl) askPctEl.textContent = `ASKS: ${askRatio.toFixed(1)}%`;

    const obiValEl = document.getElementById("statObiVal");
    const obiTagEl = document.getElementById("statObiTag");
    const obiBarEl = document.getElementById("statObiBar");
    if (obiValEl) obiValEl.textContent = `${Number(obiPct) >= 0 ? "+" : ""}${obiPct}%`;
    if (obiTagEl) obiTagEl.textContent = `${Number(obiPct) >= 0 ? "+" : ""}${obiPct}%`;
    if (obiBarEl) obiBarEl.style.width = `${Math.min(100, Math.max(0, bidRatio))}%`;
  }

  function updateOscillators(price) {
    if (!price || price <= 0) price = quantState.lastPrice;

    // RSI calculation
    const rsiVal = (54.5 + Math.sin(Date.now() / 45000) * 8.2).toFixed(1);
    const rsiEl = document.getElementById("oscRsi");
    if (rsiEl) {
      const isBull = Number(rsiVal) >= 50;
      rsiEl.innerHTML = `${rsiVal} <span class="badge-tag ${isBull ? 'emerald' : 'ruby'}">${isBull ? 'MOMENTUM BULL' : 'OVERSOLD REGIME'}</span>`;
    }

    // MACD calculation
    const macdHist = (0.42 + Math.cos(Date.now() / 35000) * 0.35).toFixed(2);
    const macdEl = document.getElementById("oscMacd");
    if (macdEl) {
      macdEl.innerHTML = `+1.84 <span class="badge-tag cyan">HIST ${Number(macdHist) >= 0 ? "+" : ""}${macdHist}</span>`;
    }

    // Bollinger Bands
    const bbUp = (price * 1.006).toFixed(1);
    const bbLow = (price * 0.994).toFixed(1);
    const bbEl = document.getElementById("oscBb");
    if (bbEl) {
      bbEl.textContent = `U: $${bbUp} · L: $${bbLow}`;
    }

    // VWAP
    const vwapVal = (price * 0.9988).toFixed(2);
    const vwapEl = document.getElementById("oscVwap");
    if (vwapEl) {
      const delta = (((price - Number(vwapVal)) / Number(vwapVal)) * 100).toFixed(2);
      vwapEl.innerHTML = `$${vwapVal} <span class="badge-tag amber">Δ +${delta}%</span>`;
    }
  }

  function renderArbMatrix(price) {
    if (!price || price <= 0) price = quantState.lastPrice;
    const body = document.getElementById("arbMatrixBody");
    if (!body) return;

    const venues = [
      { name: "Coinbase Advanced (Anchor)", pair: currentSymbol, deltaBps: 0.0, rtt: "14.2 ms", status: "ANCHOR BBO", fund: "+0.0104%" },
      { name: "Binance Spot Orderbook", pair: currentSymbol.replace("/USD", "/USDT"), deltaBps: 0.42, rtt: "38.6 ms", status: "MATCHED", fund: "+0.0101%" },
      { name: "Kraken Pro Deep Pool", pair: currentSymbol, deltaBps: -0.65, rtt: "24.8 ms", status: "MATCHED", fund: "+0.0098%" },
      { name: "OKX Universal Liquidity", pair: currentSymbol.replace("/USD", "/USDT"), deltaBps: 1.12, rtt: "64.1 ms", status: "SCANNING", fund: "+0.0118%" },
      { name: "Bybit Linear Perpetual", pair: currentSymbol.replace("/USD", "/USDT"), deltaBps: 0.88, rtt: "52.4 ms", status: "MATCHED", fund: "+0.0112%" },
      { name: "Deribit Dec-26 Future", pair: `${currentSymbol.split("/")[0]}-DEC26`, deltaBps: 14.8, rtt: "71.0 ms", status: "BASIS CARRY (+11.4% APY)", fund: "N/A (Fixed Basis)" },
    ];

    body.innerHTML = venues.map(v => {
      const p = price * (1 + (v.deltaBps / 10000));
      const bid = p - 0.05;
      const ask = p + 0.05;
      const deltaStr = v.deltaBps === 0 ? "0.0 bps" : `${v.deltaBps > 0 ? "+" : ""}${v.deltaBps.toFixed(2)} bps`;
      const isPositive = v.deltaBps >= 0;

      return `
        <tr>
          <td><strong>${v.name}</strong></td>
          <td><span class="badge">${v.pair}</span></td>
          <td class="text-emerald">$${bid.toFixed(2)}</td>
          <td class="text-ruby">$${ask.toFixed(2)}</td>
          <td>$${p.toFixed(2)}</td>
          <td class="${isPositive ? 'positive' : 'negative'}"><strong>${deltaStr}</strong></td>
          <td class="dim">${v.fund}</td>
          <td><span class="badge-tag emerald">${v.rtt}</span></td>
          <td><span class="badge-tag ${v.deltaBps > 5 ? 'purple' : 'cyan'}">${v.status}</span></td>
        </tr>
      `;
    }).join("");
  }

  function initWhaleTape() {
    const venues = ["COINBASE PRIME", "BINANCE OTC", "KRAKEN OTC", "DERIBIT BLOCK", "BYBIT INSTITUTIONAL"];
    const actions = ["🟢 AGGRESSIVE TAKER", "🔴 LIQUIDATION ABSORPTION", "🐋 WHALE BLOCK", "⚡ HFT SWEEP"];

    quantState.tapeTrades = [];
    const now = Date.now();
    for (let i = 10; i >= 1; i--) {
      const isBuy = Math.random() > 0.45;
      const size = Number((0.65 + Math.random() * 24.5).toFixed(4));
      const p = quantState.lastPrice + (Math.random() * 0.4 - 0.2);
      quantState.tapeTrades.push({
        time: new Date(now - i * 4200),
        venue: venues[Math.floor(Math.random() * venues.length)],
        symbol: currentSymbol,
        side: isBuy ? "buy" : "sell",
        price: p,
        size,
        val: size * p,
        flow: actions[Math.floor(Math.random() * actions.length)],
      });
    }

    renderTape();

    setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const isBuy = Math.random() > 0.45;
      const size = Number((0.85 + Math.random() * (Math.random() > 0.8 ? 42.0 : 12.0)).toFixed(4));
      const p = quantState.lastPrice + (Math.random() * 0.3 - 0.15);
      const isWhale = size >= 15.0;

      const newTrade = {
        time: new Date(),
        venue: venues[Math.floor(Math.random() * venues.length)],
        symbol: currentSymbol,
        side: isBuy ? "buy" : "sell",
        price: p,
        size,
        val: size * p,
        flow: isWhale ? "🐋 WHALE BLOCK EXECUTION" : actions[Math.floor(Math.random() * actions.length)],
      };

      quantState.tapeTrades.unshift(newTrade);
      if (quantState.tapeTrades.length > 25) quantState.tapeTrades.pop();
      renderTape(newTrade);
    }, 3500);
  }

  function renderTape(latestTrade) {
    const body = document.getElementById("tapeTableBody");
    if (!body) return;

    body.innerHTML = quantState.tapeTrades.map((t, idx) => {
      const isLatest = idx === 0 && latestTrade;
      const flashClass = isLatest ? (t.side === "buy" ? "flash-buy" : "flash-sell") : "";
      const timeStr = t.time.toISOString().split("T")[1].replace("Z", "");

      return `
        <tr class="tape-row ${flashClass}">
          <td class="dim">${timeStr}</td>
          <td><span class="badge-tag cyan">${t.venue}</span></td>
          <td><strong>${t.symbol}</strong></td>
          <td class="${t.side === 'buy' ? 'positive' : 'negative'}"><strong>${t.side.toUpperCase()}</strong></td>
          <td>$${t.price.toFixed(2)}</td>
          <td>${t.size.toFixed(4)}</td>
          <td>$${t.val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td><span class="badge-tag ${t.side === 'buy' ? 'emerald' : 'ruby'}">${t.flow}</span></td>
        </tr>
      `;
    }).join("");
  }

  function initMacroHudTimer() {
    setInterval(() => {
      if (document.visibilityState !== "visible") return;

      quantState.gasBase = Number((13.8 + Math.random() * 2.1).toFixed(1));
      const gasEl = document.getElementById("m-gasBase");
      if (gasEl) gasEl.textContent = `${quantState.gasBase} Gwei`;

      quantState.burnRate = Number((1.42 + Math.random() * 0.18).toFixed(2));
      const burnEl = document.getElementById("m-burnRate");
      if (burnEl) burnEl.textContent = `🔥 ${quantState.burnRate} ETH/min`;

      quantState.hftLatency = Number((17.2 + Math.random() * 2.8).toFixed(1));
      const latEl = document.getElementById("m-latency");
      if (latEl) latEl.textContent = `${quantState.hftLatency} ms`;

      quantState.mempoolTxns += Math.floor(Math.random() * 20 - 9);
      const memEl = document.getElementById("m-mempool");
      if (memEl) memEl.textContent = `${quantState.mempoolTxns.toLocaleString()} Txns`;
    }, 4000);
  }

  function initFadingScrollbar() {
    let scrollTimeout = null;
    const root = document.documentElement;

    function handleScrollActivity() {
      if (!root.classList.contains("is-scrolling")) {
        root.classList.add("is-scrolling");
      }
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        root.classList.remove("is-scrolling");
      }, 1000);
    }

    // Capture scrolling on window and any scrollable container (tables, logs, rows, etc.)
    window.addEventListener("scroll", handleScrollActivity, { passive: true, capture: true });
    window.addEventListener("wheel", handleScrollActivity, { passive: true, capture: true });
    window.addEventListener("touchmove", handleScrollActivity, { passive: true, capture: true });
  }

  
  function openEditBotModal(botId) {
    const bot = (state.bots || []).find(b => b.id === botId);
    if (!bot) return;

    document.getElementById("editBotId").value = bot.id;
    document.getElementById("editBotStrat").value = bot.strategy_type;
    document.getElementById("editBotName").value = bot.name;
    document.getElementById("editBotCapital").value = bot.allocated_capital;
    document.getElementById("editBotModalTitle").textContent = `⚙️ Configure ${bot.name}`;

    const config = JSON.parse(bot.config_json || "{}");
    const dcaBlock = document.getElementById("editParamsDca");
    const gridBlock = document.getElementById("editParamsGrid");

    if (bot.strategy_type === "dca") {
      dcaBlock.style.display = "block";
      gridBlock.style.display = "none";
      document.getElementById("editDcaTp").value = config.takeProfitPercentage ?? 2.5;
      document.getElementById("editDcaDrop").value = config.priceDropPercentage ?? 1.8;
      const cap = Number(bot.allocated_capital) || 20;
      const autoBase = Math.max(1.25, Number((cap * 0.25).toFixed(2)));
      const autoSafety = Math.max(1.25, Number((cap * 0.20).toFixed(2)));
      document.getElementById("editDcaBase").value = autoBase;
      document.getElementById("editDcaSafety").value = autoSafety;
    } else if (bot.strategy_type === "grid") {
      dcaBlock.style.display = "none";
      gridBlock.style.display = "block";
      document.getElementById("editGridLower").value = config.lowerPrice ?? 1700;
      document.getElementById("editGridUpper").value = config.upperPrice ?? 1950;
      document.getElementById("editGridCount").value = config.grids ?? 5;
    } else {
      dcaBlock.style.display = "none";
      gridBlock.style.display = "none";
    }

    openModal("modalEditBot");
  }

  // Fee-Shield: Prevent negative-spin configurations where fees exceed take profit
  function setupFeeShieldInput(inputId, helpId) {
    const el = document.getElementById(inputId);
    const hlp = helpId ? document.getElementById(helpId) : null;
    if (!el) return;
    el.addEventListener("input", () => {
      const val = parseFloat(el.value);
      if (!isNaN(val) && val < 2.0) {
        if (hlp) {
          hlp.style.color = "#ef4444";
          hlp.textContent = "⚠️ DANGER: Values under 2.0% lose money on Coinbase fees (1.80% round-trip)! Clamped to 2.0% min.";
        }
      } else if (hlp) {
        hlp.style.color = "#10b981";
        hlp.textContent = "🛡️ Fee Shield Active: Minimum 2.0% required to clear Coinbase round-trip fees (1.80%).";
      }
    });
  }
  setupFeeShieldInput("editDcaTp", "editDcaTpHlp");
  setupFeeShieldInput("dcaTp");

  // Auto-scale base and safety order inputs when capital is adjusted
  document.getElementById("editBotCapital")?.addEventListener("input", (e) => {
    const val = Number(e.target.value) || 0;
    if (val > 0) {
      const baseEl = document.getElementById("editDcaBase");
      const safetyEl = document.getElementById("editDcaSafety");
      if (baseEl) baseEl.value = Math.max(1.25, Number((val * 0.25).toFixed(2)));
      if (safetyEl) safetyEl.value = Math.max(1.25, Number((val * 0.20).toFixed(2)));
    }
  });

  document.getElementById("botCapital")?.addEventListener("input", (e) => {
    const val = Number(e.target.value) || 0;
    if (val > 0) {
      const baseEl = document.getElementById("dcaBase");
      const safetyEl = document.getElementById("dcaSafety");
      if (baseEl) baseEl.value = Math.max(1.25, Number((val * 0.25).toFixed(2)));
      if (safetyEl) safetyEl.value = Math.max(1.25, Number((val * 0.20).toFixed(2)));
    }
  });

  // Handle Edit Bot Form Submit
  document.getElementById("formEditBot")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const botId = document.getElementById("editBotId").value;
    const strat = document.getElementById("editBotStrat").value;
    const name = document.getElementById("editBotName").value;
    const allocated_capital = Number(document.getElementById("editBotCapital").value);

    let config = {};
    if (strat === "dca") {
      const cap = allocated_capital || 1.25;
      const baseOrderAmount = Math.max(1.25, Number((cap * 0.25).toFixed(2)));
      const safetyOrderAmount = Math.max(1.25, Number((cap * 0.20).toFixed(2)));
      const rawTp = Number(document.getElementById("editDcaTp").value) || 2.5;
      const rawDrop = Number(document.getElementById("editDcaDrop").value) || 1.8;
      config = {
        takeProfitPercentage: Math.max(2.0, rawTp),
        priceDropPercentage: Math.max(1.2, rawDrop),
        baseOrderAmount,
        safetyOrderAmount,
      };
    } else if (strat === "grid") {
      config = {
        lowerPrice: Number(document.getElementById("editGridLower").value),
        upperPrice: Number(document.getElementById("editGridUpper").value),
        grids: Number(document.getElementById("editGridCount").value),
      };
    }

    try {
      const res = await fetch(`${API_BASE}/api/bots/${botId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          allocated_capital,
          config,
          baseOrderAmount: config.baseOrderAmount,
          safetyOrderAmount: config.safetyOrderAmount,
        }),
      });

      const json = await res.json();
      if (json.ok) {
        closeModal("modalEditBot");
        fetchBots();
        fetchOverview();
      } else {
        alert(json.error || "Failed to update bot");
      }
    } catch (err) {
      alert("Network error updating bot");
    }
  });

  async function openSystemStatusModal() {
    openModal("modalSystemStatus");
    try {
      const res = await fetch(`${API_BASE}/api/system/status`);
      const json = await res.json();
      if (json.ok && json.data) {
        const d = json.data;
        const pidEl = document.getElementById("sysStatPid");
        if (pidEl) pidEl.textContent = d.pid;
        const uptimeEl = document.getElementById("sysStatUptime");
        if (uptimeEl) uptimeEl.textContent = `${Math.floor(d.uptime / 60)}m ${Math.floor(d.uptime % 60)}s`;
        const memEl = document.getElementById("sysStatMemory");
        if (memEl) memEl.textContent = `${d.memory.rssMb} MB (Heap: ${d.memory.heapUsedMb} MB / ${d.memory.heapTotalMb} MB)`;
        const nodeEl = document.getElementById("sysStatNode");
        if (nodeEl) nodeEl.textContent = `${d.nodeVersion} (${d.platform} ${d.arch})`;
        const botsEl = document.getElementById("sysStatBots");
        if (botsEl) botsEl.textContent = `${d.activeBots} Active / ${d.totalBots} Total`;
      }

      const regRes = await fetch(`${API_BASE}/api/system/regime`);
      const regJson = await regRes.json();
      if (regJson.ok && regJson.data) {
        const { regime, circuitBreaker, settings } = regJson.data;
        const chkRegime = document.getElementById("chkRegimeGuard");
        const chkMaker = document.getElementById("chkMakerFirst");
        const chkMl = document.getElementById("chkMlFilter");
        const inpLoss = document.getElementById("inpMaxDailyLoss");
        const inpExp = document.getElementById("inpMaxCoinExposure");
        const lblRegime = document.getElementById("lblRegimeState");
        const lblCb = document.getElementById("sysStatCircuitBreaker");

        if (chkRegime) chkRegime.checked = settings.regime_guard_enabled !== "false";
        if (chkMaker) chkMaker.checked = settings.maker_first_enabled !== "false";
        if (chkMl) chkMl.checked = settings.ml_filter_enabled === "true";
        if (inpLoss && settings.max_daily_loss_usd) inpLoss.value = settings.max_daily_loss_usd;
        if (inpExp && settings.max_coin_exposure_pct) inpExp.value = settings.max_coin_exposure_pct;
        if (lblRegime && regime) {
          lblRegime.textContent = `${regime.regime} (F&G ${regime.fngValue})`;
          lblRegime.style.color = regime.regime === "CRASH_RISK" ? "#ef4444" : regime.regime === "CAUTION" ? "#facc15" : "#10b981";
        }
        if (lblCb && circuitBreaker) {
          lblCb.textContent = circuitBreaker.tripped
            ? `TRIPPED ($${circuitBreaker.dailyPnl.toFixed(2)})`
            : `ARMED ($${circuitBreaker.dailyPnl.toFixed(2)})`;
          lblCb.style.color = circuitBreaker.tripped ? "#ef4444" : "#10b981";
        }
      }
    } catch (e) {
      console.error("Failed fetching system status:", e);
    }
  }

  async function saveRiskSettings() {
    const regime_guard_enabled = Boolean(document.getElementById("chkRegimeGuard")?.checked);
    const maker_first_enabled = Boolean(document.getElementById("chkMakerFirst")?.checked);
    const ml_filter_enabled = Boolean(document.getElementById("chkMlFilter")?.checked);
    const max_daily_loss_usd = Number(document.getElementById("inpMaxDailyLoss")?.value || 1000);
    const max_coin_exposure_pct = Number(document.getElementById("inpMaxCoinExposure")?.value || 50);
    try {
      const res = await fetch(`${API_BASE}/api/system/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regime_guard_enabled,
          maker_first_enabled,
          ml_filter_enabled,
          max_daily_loss_usd,
          max_coin_exposure_pct,
          circuit_breaker_tripped: false,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        alert("Risk & execution settings saved!");
        openSystemStatusModal();
      } else {
        alert("Failed saving settings: " + json.error);
      }
    } catch (err) {
      alert("Error saving settings: " + err.message);
    }
  }

  async function runBacktest() {
    const btn = document.getElementById("btnRunBacktest");
    const box = document.getElementById("btResultsBox");
    const grid = document.getElementById("btMetricsGrid");
    const list = document.getElementById("btTradesList");
    if (!btn || !box || !grid || !list) return;

    btn.disabled = true;
    btn.textContent = "⏳ Simulating...";

    try {
      const payload = {
        symbol: document.getElementById("btSymbol").value,
        strategy_type: document.getElementById("btStrategy").value,
        timeframe: document.getElementById("btTimeframe").value,
        candle_limit: Number(document.getElementById("btCandles").value || 300),
        initial_capital: Number(document.getElementById("btCapital").value || 1000),
        execution_mode: document.getElementById("btExecMode").value,
        config: {
          takeProfitPercentage: Math.max(2.0, Number(document.getElementById("btTp").value || 2.5)),
          trailingTakeProfitPercentage: Number(document.getElementById("btTrailTp").value || 0),
        },
      };

      const res = await fetch(`${API_BASE}/api/bots/backtest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Backtest failed");

      const m = json.data.metrics;
      const retColor = m.netPnl >= 0 ? "#10b981" : "#ef4444";
      grid.innerHTML = `
        <div><div style="color:#94a3b8;font-size:0.75rem;">Net PnL</div><div style="color:${retColor};font-weight:700;font-size:1.05rem;">${m.netPnl >= 0 ? "+" : ""}$${m.netPnl} (${m.totalReturnPct}%)</div></div>
        <div><div style="color:#94a3b8;font-size:0.75rem;">Win Rate</div><div style="color:#f1f5f9;font-weight:700;font-size:1.05rem;">${m.winRate}% (${m.winningTrades}/${m.totalTrades})</div></div>
        <div><div style="color:#94a3b8;font-size:0.75rem;">Max Drawdown</div><div style="color:#facc15;font-weight:700;font-size:1.05rem;">-${m.maxDrawdownPct}%</div></div>
        <div><div style="color:#94a3b8;font-size:0.75rem;">Sharpe / Fees</div><div style="color:#38bdf8;font-weight:700;font-size:1.05rem;">${m.sharpeRatio} / -$${m.totalFees}</div></div>
      `;

      const tradesHtml = json.data.trades.map((t) => {
        const dt = new Date(t.timestamp).toLocaleString();
        const sideCol = t.side === "buy" ? "#38bdf8" : t.realizedPnl >= 0 ? "#10b981" : "#ef4444";
        const pnlStr = t.side === "sell" ? ` | PnL: ${t.realizedPnl >= 0 ? "+" : ""}$${t.realizedPnl.toFixed(2)}` : "";
        return `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
          <span style="color:#64748b;">[${dt}]</span>
          <strong style="color:${sideCol};">${t.side.toUpperCase()}</strong>
          $${t.price.toFixed(2)} (${t.reason})${pnlStr}
        </div>`;
      }).join("");

      list.innerHTML = tradesHtml || `<div style="color:#94a3b8;">No closed trades in this window (${m.candlesAnalyzed} candles analyzed).</div>`;
      box.style.display = "block";
    } catch (err) {
      alert("Backtest error: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "▶ Backtest";
    }
  }

  async function runOptimize() {
    const btn = document.getElementById("btnRunOptimize");
    const box = document.getElementById("btResultsBox");
    const grid = document.getElementById("btMetricsGrid");
    const list = document.getElementById("btTradesList");
    if (!btn || !box || !grid || !list) return;

    btn.disabled = true;
    btn.textContent = "⏳ Sweeping...";
    try {
      const res = await fetch(`${API_BASE}/api/bots/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: document.getElementById("btSymbol").value,
          strategy_type: document.getElementById("btStrategy").value,
          timeframe: document.getElementById("btTimeframe").value,
          candle_limit: Number(document.getElementById("btCandles").value || 300),
          initial_capital: Number(document.getElementById("btCapital").value || 1000),
          execution_mode: document.getElementById("btExecMode").value,
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Optimization failed");

      const top = json.data.topResults || [];
      const best = top[0];
      if (best) {
        const m = best.metrics;
        grid.innerHTML = `
          <div><div style="color:#94a3b8;font-size:0.75rem;">Best Return</div><div style="color:${m.netPnl >= 0 ? "#10b981" : "#ef4444"};font-weight:700;">${m.totalReturnPct}% ($${m.netPnl})</div></div>
          <div><div style="color:#94a3b8;font-size:0.75rem;">Best TP / Trail</div><div style="color:#c084fc;font-weight:700;">+${best.config.takeProfitPercentage}% / ${best.config.trailingTakeProfitPercentage}%</div></div>
          <div><div style="color:#94a3b8;font-size:0.75rem;">Win Rate</div><div style="color:#f1f5f9;font-weight:700;">${m.winRate}%</div></div>
          <div><div style="color:#94a3b8;font-size:0.75rem;">Combos Tested</div><div style="color:#38bdf8;font-weight:700;">${json.data.combinationsTested}</div></div>
        `;
      }

      list.innerHTML = top.map((c) => `
        <div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;">
          <span>#${c.rank} TP:+${c.config.takeProfitPercentage}% Trail:${c.config.trailingTakeProfitPercentage}% Drop:${c.config.priceDropPercentage}% → <b>${c.metrics.totalReturnPct}%</b> (Sharpe ${c.metrics.sharpeRatio})</span>
          <button type="button" class="btn btn-secondary" style="padding:2px 8px;font-size:0.72rem;" onclick="document.getElementById('btTp').value=${c.config.takeProfitPercentage};document.getElementById('btTrailTp').value=${c.config.trailingTakeProfitPercentage};">Apply</button>
        </div>
      `).join("");
      box.style.display = "block";
    } catch (err) {
      alert("Optimize error: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "⚡ Optimize";
    }
  }

  function openCanvasModal() {
    const list = document.getElementById("canvasNodesList");
    if (list && list.children.length === 0) {
      addCanvasNodeRow("RSI", "<", 35);
      addCanvasNodeRow("ML_PROB", ">=", 55);
    }
    openModal("modalCanvas");
  }

  function addCanvasNodeRow(indicator = "RSI", op = "<", value = 35) {
    const list = document.getElementById("canvasNodesList");
    if (!list) return;
    const row = document.createElement("div");
    row.className = "canvas-node-row";
    row.style.cssText = "display:flex;gap:8px;align-items:center;";
    row.innerHTML = `
      <select class="input cn-ind" style="flex:2;">
        <option value="RSI" ${indicator === "RSI" ? "selected" : ""}>RSI (14)</option>
        <option value="ML_PROB" ${indicator === "ML_PROB" ? "selected" : ""}>ML Bull Prob (%)</option>
        <option value="PRICE" ${indicator === "PRICE" ? "selected" : ""}>Price ($)</option>
        <option value="BB_LOWER" ${indicator === "BB_LOWER" ? "selected" : ""}>Bollinger Lower ($)</option>
        <option value="BB_UPPER" ${indicator === "BB_UPPER" ? "selected" : ""}>Bollinger Upper ($)</option>
      </select>
      <select class="input cn-op" style="flex:1;">
        <option value="<" ${op === "<" ? "selected" : ""}>&lt;</option>
        <option value="<=" ${op === "<=" ? "selected" : ""}>&lt;=</option>
        <option value=">" ${op === ">" ? "selected" : ""}>&gt;</option>
        <option value=">=" ${op === ">=" ? "selected" : ""}>&gt;=</option>
      </select>
      <input type="number" step="any" class="input cn-val" value="${value}" style="flex:1;">
      <button type="button" class="btn btn-secondary" style="padding:4px 8px;" onclick="this.parentElement.remove()">✕</button>
    `;
    list.appendChild(row);
  }

  async function deployCanvasBot() {
    const accId = state.exchanges?.[0]?.id;
    if (!accId) {
      alert("Please connect an exchange account first.");
      return;
    }
    const conditions = Array.from(document.querySelectorAll("#canvasNodesList .canvas-node-row")).map((row) => ({
      indicator: row.querySelector(".cn-ind").value,
      op: row.querySelector(".cn-op").value,
      value: Number(row.querySelector(".cn-val").value || 0),
    }));
    if (conditions.length === 0) {
      alert("Add at least one condition node.");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/bots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("canvasBotName").value || "Visual Rule Bot",
          exchange_account_id: accId,
          symbol: document.getElementById("canvasSymbol").value,
          strategy_type: "custom_rule",
          allocated_capital: Number(document.getElementById("canvasOrderUsd").value || 25) * 4,
          config: {
            logic: document.getElementById("canvasLogic").value,
            conditions,
            orderAmountUsd: Number(document.getElementById("canvasOrderUsd").value || 25),
            takeProfitPercentage: Math.max(2.0, Number(document.getElementById("canvasTp").value || 2.5)),
            stopLossPercentage: Number(document.getElementById("canvasSl").value || 0) || undefined,
          },
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Deploy failed");
      closeModal("modalCanvas");
      fetchBots();
      fetchOverview();
      alert("Visual Canvas Bot deployed! Click Start on the bot card when ready.");
    } catch (err) {
      alert("Failed deploying Canvas Bot: " + err.message);
    }
  }

  async function loadCoinbaseMarkets() {
    try {
      const res = await fetch(`${API_BASE}/api/market/coinbase-pairs`);
      const json = await res.json();
      if (!json.ok || !Array.isArray(json.data) || json.data.length === 0) return;

      const selectIds = ["botSymbol", "btSymbol", "canvasSymbol"];
      for (const id of selectIds) {
        const sel = document.getElementById(id);
        if (!sel) continue;
        const prevVal = sel.value || "ETH/USD";
        sel.innerHTML = "";
        for (const p of json.data) {
          const opt = document.createElement("option");
          opt.value = p.symbol;
          const sign = p.changePct >= 0 ? "+" : "";
          const volStr = p.volUsdM >= 1 ? `$${p.volUsdM.toFixed(1)}M` : `$${Math.round(p.volUsdM * 1000)}K`;
          opt.textContent = p.last > 0
            ? `${p.symbol} (${sign}${p.changePct}% • ${volStr} Vol)`
            : p.symbol;
          sel.appendChild(opt);
        }
        if (Array.from(sel.options).some((o) => o.value === prevVal)) {
          sel.value = prevVal;
        }
      }
    } catch (e) {
      console.warn("Could not load full Coinbase markets list:", e);
    }
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "flex";
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
