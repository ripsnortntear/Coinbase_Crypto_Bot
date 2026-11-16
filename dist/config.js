"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const envPath = process.env.ENV_FILE || path_1.default.resolve(__dirname, "../.env");
dotenv_1.default.config({ path: envPath });
const baseDir = path_1.default.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR || path_1.default.join(baseDir, "data");
exports.CONFIG = {
    appName: "Coinbase Crypto Bot",
    fqdn: process.env.FQDN || "localhost",
    port: Number(process.env.PORT) || 29600,
    host: process.env.HOST || "0.0.0.0",
    basePath: (process.env.BASE_PATH || "").replace(/\/+$/, ""),
    encryptionKey: process.env.ENCRYPTION_KEY ||
        "cb0c90f6080b33f41304a4feb020d328619e3f3d77803b26e40082016c9294d4",
    sessionSecret: process.env.SESSION_SECRET ||
        "cb_bot_secure_session_secret_replace_in_production_2026",
    rootAdminUser: (process.env.ROOT_ADMIN_USER || "admin").toLowerCase(),
    dataDir,
    dbFile: path_1.default.join(dataDir, "trading.db"),
};
