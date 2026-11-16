"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.maskSecret = maskSecret;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const ALGORITHM = "aes-256-gcm";
const KEY_BUFFER = Buffer.from(config_1.CONFIG.encryptionKey, "hex");
function encrypt(text) {
    if (!text)
        return "";
    const iv = crypto_1.default.randomBytes(16);
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, KEY_BUFFER, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();
    // Format: iv:tag:encrypted
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}
function decrypt(encryptedText) {
    if (!encryptedText)
        return "";
    const parts = encryptedText.split(":");
    if (parts.length !== 3) {
        throw new Error("Invalid encrypted payload format");
    }
    const [ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto_1.default.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(dataHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}
function maskSecret(secret) {
    if (!secret)
        return "";
    if (secret.length <= 8)
        return "********";
    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
