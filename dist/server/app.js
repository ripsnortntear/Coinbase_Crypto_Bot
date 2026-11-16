"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_1 = require("./routes/auth");
const bots_1 = require("./routes/bots");
const exchanges_1 = require("./routes/exchanges");
const orders_1 = require("./routes/orders");
const market_1 = require("./routes/market");
const system_1 = require("./routes/system");
const auth_2 = require("../security/auth");
const config_1 = require("../config");
function createApp(botRunner, exchangeManager) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(express_1.default.urlencoded({ extended: true }));
    // Global authentication & session guard
    app.use(auth_2.authMiddleware);
    const publicDir = path_1.default.resolve(__dirname, "../../public");
    // Helper to serve index.html with runtime injected config
    const serveSpa = (req, res) => {
        try {
            const htmlPath = path_1.default.join(publicDir, "index.html");
            let html = fs_1.default.readFileSync(htmlPath, "utf8");
            const injection = `
  <script>
    window.__BASE_PATH__ = "${config_1.CONFIG.basePath}";
    window.__FQDN__ = "${config_1.CONFIG.fqdn}";
    window.__APP_NAME__ = "${config_1.CONFIG.appName}";
  </script>`;
            html = html.replace("<head>", `<head>${injection}`);
            res.setHeader("Content-Type", "text/html");
            res.send(html);
        }
        catch {
            res.sendFile(path_1.default.join(publicDir, "index.html"));
        }
    };
    // Setup routers
    const authRouter = (0, auth_1.createAuthRouter)();
    const botsRouter = (0, bots_1.createBotsRouter)(botRunner);
    const exchangesRouter = (0, exchanges_1.createExchangesRouter)(exchangeManager);
    const ordersRouter = (0, orders_1.createOrdersRouter)(exchangeManager);
    const marketRouter = (0, market_1.createMarketRouter)(exchangeManager);
    const systemRouter = (0, system_1.createSystemRouter)(botRunner, exchangeManager);
    // Mount API endpoints at standard /api
    app.use("/api/auth", authRouter);
    app.use("/api/bots", botsRouter);
    app.use("/api/exchanges", exchangesRouter);
    app.use("/api/orders", ordersRouter);
    app.use("/api/market", marketRouter);
    app.use("/api/system", systemRouter);
    // If a subpath is configured (e.g. /crypto), mount them there as well for reverse-proxy compatibility
    if (config_1.CONFIG.basePath && config_1.CONFIG.basePath !== "") {
        app.use(`${config_1.CONFIG.basePath}/api/auth`, authRouter);
        app.use(`${config_1.CONFIG.basePath}/api/bots`, botsRouter);
        app.use(`${config_1.CONFIG.basePath}/api/exchanges`, exchangesRouter);
        app.use(`${config_1.CONFIG.basePath}/api/orders`, ordersRouter);
        app.use(`${config_1.CONFIG.basePath}/api/market`, marketRouter);
        app.use(`${config_1.CONFIG.basePath}/api/system`, systemRouter);
        app.use(config_1.CONFIG.basePath, express_1.default.static(publicDir));
        app.get(`${config_1.CONFIG.basePath}*`, serveSpa);
    }
    // Static files and SPA fallback
    app.use(express_1.default.static(publicDir));
    app.use(serveSpa);
    // Error handling middleware
    app.use((err, req, res, next) => {
        console.error("[Express Error Handler]", err);
        res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
    });
    return app;
}
