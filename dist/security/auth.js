"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.generateSalt = generateSalt;
exports.verifyPassword = verifyPassword;
exports.createSession = createSession;
exports.verifySession = verifySession;
exports.destroySession = destroySession;
exports.parseSessionToken = parseSessionToken;
exports.authMiddleware = authMiddleware;
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../db/database");
const config_1 = require("../config");
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
function hashPassword(password, salt) {
    return crypto_1.default.scryptSync(password, salt, 64).toString("hex");
}
function generateSalt() {
    return crypto_1.default.randomBytes(16).toString("hex");
}
function verifyPassword(password, salt, expectedHash) {
    const actualHash = hashPassword(password, salt);
    return crypto_1.default.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"));
}
function createSession(userId, username) {
    const token = `cbsess_${crypto_1.default.randomBytes(32).toString("hex")}`;
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const db = (0, database_1.getDatabase)();
    db.prepare(`
    INSERT INTO user_sessions (token, user_id, username, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, username, expiresAt);
    return token;
}
function verifySession(token) {
    if (!token)
        return null;
    const db = (0, database_1.getDatabase)();
    const now = Math.floor(Date.now() / 1000);
    const session = db.prepare(`
    SELECT user_id, username, expires_at
    FROM user_sessions
    WHERE token = ? AND expires_at > ?
  `).get(token, now);
    if (!session)
        return null;
    return { userId: session.user_id, username: session.username };
}
function destroySession(token) {
    if (!token)
        return;
    const db = (0, database_1.getDatabase)();
    db.prepare("DELETE FROM user_sessions WHERE token = ?").run(token);
}
function parseSessionToken(req) {
    // 1. Check Bearer Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7).trim();
    }
    // 2. Check Cookie header for cb_session
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        const match = cookieHeader.match(/(?:^|;\s*)cb_session=([^;]+)/);
        if (match)
            return decodeURIComponent(match[1]);
    }
    return null;
}
function authMiddleware(req, res, next) {
    // Allow public static assets and auth API endpoints without login
    const path = req.path;
    if (path.startsWith("/api/auth/login") ||
        path.startsWith("/api/system/health") ||
        path.endsWith(".css") ||
        path.endsWith(".js") ||
        path.endsWith(".png") ||
        path.endsWith(".ico") ||
        path.endsWith(".svg")) {
        return next();
    }
    // Optional SSO Reverse-Proxy fallback: if x-forwarded-user matches root admin
    const forwardedUser = req.headers["x-forwarded-user"] || "";
    if (forwardedUser && forwardedUser.toLowerCase() === config_1.CONFIG.rootAdminUser) {
        req.user = { username: forwardedUser, isRoot: true };
        return next();
    }
    const token = parseSessionToken(req);
    if (token) {
        const verified = verifySession(token);
        if (verified) {
            req.user = verified;
            return next();
        }
    }
    // If request is an API call, return 401 Unauthorized
    if (path.startsWith("/api/")) {
        res.status(401).json({ ok: false, error: "Authentication required", loginRequired: true });
        return;
    }
    // For web UI, let the frontend index.html render and show the login modal
    next();
}
