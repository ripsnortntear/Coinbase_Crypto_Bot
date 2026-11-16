import path from "path";
import dotenv from "dotenv";

const envPath = process.env.ENV_FILE || path.resolve(__dirname, "../.env");
dotenv.config({ path: envPath });

const baseDir = path.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR || path.join(baseDir, "data");

export const CONFIG = {
  appName: "Coinbase Crypto Bot",
  fqdn: process.env.FQDN || "localhost",
  port: Number(process.env.PORT) || 29600,
  host: process.env.HOST || "0.0.0.0",
  basePath: (process.env.BASE_PATH || "").replace(/\/+$/, ""),
  encryptionKey:
    process.env.ENCRYPTION_KEY ||
    "cb0c90f6080b33f41304a4feb020d328619e3f3d77803b26e40082016c9294d4",
  sessionSecret:
    process.env.SESSION_SECRET ||
    "cb_bot_secure_session_secret_replace_in_production_2026",
  rootAdminUser: (process.env.ROOT_ADMIN_USER || "admin").toLowerCase(),
  dataDir,
  dbFile: path.join(dataDir, "trading.db"),
};
