"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyPluginLoader = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class StrategyPluginLoader {
    static plugins = new Map();
    static pluginDir = path_1.default.resolve(__dirname, "strategies/plugins");
    static loadAll() {
        this.plugins.clear();
        if (!fs_1.default.existsSync(this.pluginDir)) {
            try {
                fs_1.default.mkdirSync(this.pluginDir, { recursive: true });
            }
            catch {
                return [];
            }
        }
        const loaded = [];
        const files = fs_1.default.readdirSync(this.pluginDir).filter((f) => f.endsWith(".js") && !f.endsWith(".d.ts"));
        for (const file of files) {
            const fullPath = path_1.default.join(this.pluginDir, file);
            try {
                // Bust require cache so plugins are genuinely hot-swappable without process restart
                delete require.cache[require.resolve(fullPath)];
                const mod = require(fullPath);
                const StrategyClass = mod.default || mod.Strategy || Object.values(mod).find((v) => typeof v === "function");
                const pluginName = String(mod.strategyName || path_1.default.basename(file, ".js")).toLowerCase();
                if (typeof StrategyClass === "function") {
                    this.plugins.set(pluginName, StrategyClass);
                    loaded.push(pluginName);
                    console.log(`[PluginLoader] Loaded hot-swappable strategy plugin: ${pluginName}`);
                }
            }
            catch (err) {
                console.warn(`[PluginLoader] Failed loading plugin ${file}:`, err.message);
            }
        }
        return loaded;
    }
    static get(name) {
        if (this.plugins.size === 0) {
            this.loadAll();
        }
        return this.plugins.get(name.toLowerCase());
    }
    static list() {
        return Array.from(this.plugins.keys());
    }
}
exports.StrategyPluginLoader = StrategyPluginLoader;
