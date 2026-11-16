"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRouter = createAuthRouter;
const express_1 = require("express");
const database_1 = require("../../db/database");
const auth_1 = require("../../security/auth");
function createAuthRouter() {
    const router = (0, express_1.Router)();
    const db = (0, database_1.getDatabase)();
    // Login endpoint
    router.post("/login", (req, res) => {
        try {
            const { username, password } = req.body;
            if (!username || !password) {
                return res.status(400).json({ ok: false, error: "Username and password required" });
            }
            const user = db.prepare(`
        SELECT id, username, password_hash, salt
        FROM admin_users
        WHERE LOWER(username) = LOWER(?)
      `).get(username.trim());
            if (!user) {
                return res.status(401).json({ ok: false, error: "Invalid username or password" });
            }
            const isValid = (0, auth_1.verifyPassword)(password, user.salt, user.password_hash);
            if (!isValid) {
                return res.status(401).json({ ok: false, error: "Invalid username or password" });
            }
            const token = (0, auth_1.createSession)(user.id, user.username);
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
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Logout endpoint
    router.post("/logout", (req, res) => {
        try {
            const token = (0, auth_1.parseSessionToken)(req);
            if (token) {
                (0, auth_1.destroySession)(token);
            }
            res.clearCookie("cb_session");
            res.json({ ok: true, message: "Logged out successfully" });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    // Current session info
    router.get("/me", (req, res) => {
        try {
            const user = req.user;
            if (!user) {
                return res.status(401).json({ ok: false, error: "Unauthenticated" });
            }
            res.json({ ok: true, data: { user } });
        }
        catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    return router;
}
