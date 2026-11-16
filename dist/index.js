"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const config_1 = require("./config");
const database_1 = require("./db/database");
const exchange_manager_1 = require("./engine/exchange-manager");
const bot_runner_1 = require("./engine/bot-runner");
const app_1 = require("./server/app");
const websocket_1 = require("./server/websocket");
async function main() {
    console.log("==================================================");
    console.log(` ${config_1.CONFIG.appName} & Operations Terminal`);
    console.log("==================================================");
    // 1. Initialize SQLite Database
    console.log("[1/4] Initializing database engine...");
    (0, database_1.getDatabase)();
    // 2. Initialize Exchange Manager & Bot Runner
    console.log("[2/4] Initializing CCXT & trading engine...");
    const exchangeManager = new exchange_manager_1.ExchangeManager();
    const botRunner = new bot_runner_1.BotRunner(exchangeManager);
    // 3. Start Bot Execution Loop
    await botRunner.start();
    // 4. Create HTTP & WebSocket Server
    console.log("[3/4] Starting HTTP API & WebSocket services...");
    const app = (0, app_1.createApp)(botRunner, exchangeManager);
    const server = http_1.default.createServer(app);
    new websocket_1.WebSocketManager(server, botRunner);
    // 5. Listen
    server.listen(config_1.CONFIG.port, config_1.CONFIG.host, () => {
        const displayHost = config_1.CONFIG.host === "0.0.0.0" ? "localhost" : config_1.CONFIG.host;
        const url = config_1.CONFIG.basePath ? `http://${displayHost}:${config_1.CONFIG.port}${config_1.CONFIG.basePath}` : `http://${displayHost}:${config_1.CONFIG.port}`;
        console.log(`[4/4] ✓ ${config_1.CONFIG.appName} online at ${url}`);
        if (config_1.CONFIG.fqdn && config_1.CONFIG.fqdn !== "localhost") {
            console.log(`[✓] Public Domain / FQDN: https://${config_1.CONFIG.fqdn}${config_1.CONFIG.basePath}`);
        }
    });
    const shutdown = async (signal) => {
        console.log(`\n[*] Caught ${signal}. Gracefully stopping crypto trading bots...`);
        try {
            botRunner.stop();
        }
        catch { }
        const forceExitTimer = setTimeout(() => {
            console.log("[!] Force exiting remaining sockets...");
            process.exit(0);
        }, 1500);
        forceExitTimer.unref();
        if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
        }
        server.close(() => {
            console.log("[✓] Server terminated cleanly.");
            process.exit(0);
        });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}
main().catch((err) => {
    console.error("[Fatal Error]", err);
    process.exit(1);
});
