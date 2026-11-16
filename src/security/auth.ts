import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { getDatabase } from "../db/database";
import { CONFIG } from "../config";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function generateSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actualHash = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"));
}

export function createSession(userId: string, username: string): string {
  const token = `cbsess_${crypto.randomBytes(32).toString("hex")}`;
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const db = getDatabase();

  db.prepare(`
    INSERT INTO user_sessions (token, user_id, username, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, username, expiresAt);

  return token;
}

export function verifySession(token: string): { userId: string; username: string } | null {
  if (!token) return null;
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const session = db.prepare(`
    SELECT user_id, username, expires_at
    FROM user_sessions
    WHERE token = ? AND expires_at > ?
  `).get(token, now) as { user_id: string; username: string; expires_at: number } | undefined;

  if (!session) return null;
  return { userId: session.user_id, username: session.username };
}

export function destroySession(token: string): void {
  if (!token) return;
  const db = getDatabase();
  db.prepare("DELETE FROM user_sessions WHERE token = ?").run(token);
}

export function parseSessionToken(req: Request): string | null {
  // 1. Check Bearer Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7).trim();
  }

  // 2. Check Cookie header for cb_session
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)cb_session=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }

  return null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Allow public static assets and auth API endpoints without login
  const path = req.path;
  if (
    path.startsWith("/api/auth/login") ||
    path.startsWith("/api/system/health") ||
    path.endsWith(".css") ||
    path.endsWith(".js") ||
    path.endsWith(".png") ||
    path.endsWith(".ico") ||
    path.endsWith(".svg")
  ) {
    return next();
  }

  // Optional SSO Reverse-Proxy fallback: if x-forwarded-user matches root admin
  const forwardedUser = (req.headers["x-forwarded-user"] as string) || "";
  if (forwardedUser && forwardedUser.toLowerCase() === CONFIG.rootAdminUser) {
    (req as any).user = { username: forwardedUser, isRoot: true };
    return next();
  }

  const token = parseSessionToken(req);
  if (token) {
    const verified = verifySession(token);
    if (verified) {
      (req as any).user = verified;
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
