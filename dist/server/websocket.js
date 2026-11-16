"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketManager = void 0;
const ws_1 = require("ws");
class WebSocketManager {
    wss;
    clients = new Set();
    constructor(server, botRunner) {
        this.wss = new ws_1.WebSocketServer({ noServer: true });
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
                }
                else {
                    console.warn(`[WS Upgrade Rejected] unknown pathname "${pathname}"`);
                    socket.destroy();
                }
            }
            catch (err) {
                console.error(`[WS Upgrade Error] ${err.message}`);
                socket.destroy();
            }
        });
        this.wss.on("connection", (ws) => {
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
    broadcast(type, data) {
        const payload = JSON.stringify({ type, data, timestamp: Date.now() });
        for (const client of this.clients) {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                try {
                    client.send(payload);
                }
                catch { }
            }
        }
    }
}
exports.WebSocketManager = WebSocketManager;
