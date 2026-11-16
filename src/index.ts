import http from "http";
import { CONFIG } from "./config";
import { getDatabase } from "./db/database";
import { ExchangeManager } from "./engine/exchange-manager";
import { BotRunner } from "./engine/bot-runner";
import { createApp } from "./server/app";
import { WebSocketManager } from "./server/websocket";

async function main(): Promise<void> {
  console.log("==================================================");
  console.log(` ${CONFIG.appName} & Operations Terminal`);
  console.log("==================================================");

  // 1. Initialize SQLite Database
  console.log("[1/4] Initializing database engine...");
  getDatabase();

  // 2. Initialize Exchange Manager & Bot Runner
  console.log("[2/4] Initializing CCXT & trading engine...");
  const exchangeManager = new ExchangeManager();
  const botRunner = new BotRunner(exchangeManager);

  // 3. Start Bot Execution Loop
  await botRunner.start();

  // 4. Create HTTP & WebSocket Server
  console.log("[3/4] Starting HTTP API & WebSocket services...");
  const app = createApp(botRunner, exchangeManager);
  const server = http.createServer(app);
  new WebSocketManager(server, botRunner);

  // 5. Listen
  server.listen(CONFIG.port, CONFIG.host, () => {
    const displayHost = CONFIG.host === "0.0.0.0" ? "localhost" : CONFIG.host;
    const url = CONFIG.basePath ? `http://${displayHost}:${CONFIG.port}${CONFIG.basePath}` : `http://${displayHost}:${CONFIG.port}`;
    console.log(`[4/4] ✓ ${CONFIG.appName} online at ${url}`);
    if (CONFIG.fqdn && CONFIG.fqdn !== "localhost") {
      console.log(`[✓] Public Domain / FQDN: https://${CONFIG.fqdn}${CONFIG.basePath}`);
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[*] Caught ${signal}. Gracefully stopping crypto trading bots...`);
    try {
      botRunner.stop();
    } catch {}

    const forceExitTimer = setTimeout(() => {
      console.log("[!] Force exiting remaining sockets...");
      process.exit(0);
    }, 1500);
    forceExitTimer.unref();

    if (typeof (server as any).closeAllConnections === "function") {
      (server as any).closeAllConnections();
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
