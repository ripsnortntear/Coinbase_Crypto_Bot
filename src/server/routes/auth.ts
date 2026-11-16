import { Router, Request, Response } from "express";
import { getDatabase } from "../../db/database";
import { verifyPassword, createSession, destroySession, parseSessionToken } from "../../security/auth";

export function createAuthRouter(): Router {
  const router = Router();
  const db = getDatabase();

  // Login endpoint
  router.post("/login", (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ ok: false, error: "Username and password required" });
      }

      const user = db.prepare(`
        SELECT id, username, password_hash, salt
        FROM admin_users
        WHERE LOWER(username) = LOWER(?)
      `).get(username.trim()) as { id: string; username: string; password_hash: string; salt: string } | undefined;

      if (!user) {
        return res.status(401).json({ ok: false, error: "Invalid username or password" });
      }

      const isValid = verifyPassword(password, user.salt, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ ok: false, error: "Invalid username or password" });
      }

      const token = createSession(user.id, user.username);

      // Set cookie for browser sessions
      res.cookie("cb_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: false, // will work over both http and https
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.json({
        ok: true,
        data: {
          token,
          user: { id: user.id, username: user.username },
        },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Logout endpoint
  router.post("/logout", (req: Request, res: Response) => {
    try {
      const token = parseSessionToken(req);
      if (token) {
        destroySession(token);
      }
      res.clearCookie("cb_session");
      res.json({ ok: true, message: "Logged out successfully" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Current session info
  router.get("/me", (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ ok: false, error: "Unauthenticated" });
      }
      res.json({ ok: true, data: { user } });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
