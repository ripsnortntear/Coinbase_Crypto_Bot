import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { BotRunner } from "../engine/bot-runner";

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(server: Server, botRunner: BotRunner) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      try {
        const urlStr = request.url || "";
        const host = request.headers.host || "localhost";
        console.log(`[WS Upgrade Attempt] url: "${urlStr}" host: "${host}" upgrade: "${request.headers.upgrade}"`);
        const pathname = new URL(urlStr, `http://${host}`).pathname;
        if (pathname === "/ws" || pathname === "/crypto/ws" || pathname.endsWith("/ws") || pathname.endsWith("/ws/")) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            console.log(`[WS Upgrade Success] client connected via ${pathname}`);
            this.wss.emit("connection", ws, request);
          });
        } else {
          console.warn(`[WS Upgrade Rejected] unknown pathname "${pathname}"`);
          socket.destroy();
        }
      } catch (err: any) {
        console.error(`[WS Upgrade Error] ${err.message}`);
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);

      ws.on("close", () => {
        this.clients.delete(ws);
      });

      ws.on("error", (err) => {
        console.error("[WebSocket Client Error]", err);
        this.clients.delete(ws);
      });

      // Send initial welcome message
      ws.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));
    });

    // Wire up BotRunner events to broadcast
    botRunner.on("ticker", (ticker) => {
      this.broadcast("ticker", ticker);
    });

    botRunner.on("trade", (trade) => {
      this.broadcast("trade", trade);
    });

    botRunner.on("bot_status", (status) => {
      this.broadcast("bot_status", status);
    });

    botRunner.on("panic", (data) => {
      this.broadcast("panic", data);
    });
  }

  public broadcast(type: string, data: any): void {
    const payload = JSON.stringify({ type, data, timestamp: Date.now() });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch {}
      }
    }
  }
}
