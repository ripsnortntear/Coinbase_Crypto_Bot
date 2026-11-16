import express, { Express, Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { BotRunner } from "../engine/bot-runner";
import { ExchangeManager } from "../engine/exchange-manager";
import { createAuthRouter } from "./routes/auth";
import { createBotsRouter } from "./routes/bots";
import { createExchangesRouter } from "./routes/exchanges";
import { createOrdersRouter } from "./routes/orders";
import { createMarketRouter } from "./routes/market";
import { createSystemRouter } from "./routes/system";
import { authMiddleware } from "../security/auth";
import { CONFIG } from "../config";

export function createApp(botRunner: BotRunner, exchangeManager: ExchangeManager): Express {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Global authentication & session guard
  app.use(authMiddleware);

  const publicDir = path.resolve(__dirname, "../../public");

  // Helper to serve index.html with runtime injected config
  const serveSpa = (req: Request, res: Response) => {
    try {
      const htmlPath = path.join(publicDir, "index.html");
      let html = fs.readFileSync(htmlPath, "utf8");
      const injection = `
  <script>
    window.__BASE_PATH__ = "${CONFIG.basePath}";
    window.__FQDN__ = "${CONFIG.fqdn}";
    window.__APP_NAME__ = "${CONFIG.appName}";
  </script>`;
      html = html.replace("<head>", `<head>${injection}`);
      res.setHeader("Content-Type", "text/html");
      res.send(html);
    } catch {
      res.sendFile(path.join(publicDir, "index.html"));
    }
  };

  // Setup routers
  const authRouter = createAuthRouter();
  const botsRouter = createBotsRouter(botRunner);
  const exchangesRouter = createExchangesRouter(exchangeManager);
  const ordersRouter = createOrdersRouter(exchangeManager);
  const marketRouter = createMarketRouter(exchangeManager);
  const systemRouter = createSystemRouter(botRunner, exchangeManager);

  // Mount API endpoints at standard /api
  app.use("/api/auth", authRouter);
  app.use("/api/bots", botsRouter);
  app.use("/api/exchanges", exchangesRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/market", marketRouter);
  app.use("/api/system", systemRouter);

  // If a subpath is configured (e.g. /crypto), mount them there as well for reverse-proxy compatibility
  if (CONFIG.basePath && CONFIG.basePath !== "") {
    app.use(`${CONFIG.basePath}/api/auth`, authRouter);
    app.use(`${CONFIG.basePath}/api/bots`, botsRouter);
    app.use(`${CONFIG.basePath}/api/exchanges`, exchangesRouter);
    app.use(`${CONFIG.basePath}/api/orders`, ordersRouter);
    app.use(`${CONFIG.basePath}/api/market`, marketRouter);
    app.use(`${CONFIG.basePath}/api/system`, systemRouter);
    app.use(CONFIG.basePath, express.static(publicDir));
    app.get(`${CONFIG.basePath}*`, serveSpa);
  }

  // Static files and SPA fallback
  app.use(express.static(publicDir));
  app.use(serveSpa);

  // Error handling middleware
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("[Express Error Handler]", err);
    res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
  });

  return app;
}
