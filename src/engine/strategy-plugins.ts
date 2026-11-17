import fs from "fs";
import path from "path";
import { BaseStrategy } from "./strategies/base-strategy";

export type StrategyConstructor = new (bot: any, account: any, exchangeManager: any) => BaseStrategy;

export class StrategyPluginLoader {
  private static plugins: Map<string, StrategyConstructor> = new Map();
  private static pluginDir = path.resolve(__dirname, "strategies/plugins");

  public static loadAll(): string[] {
    this.plugins.clear();
    if (!fs.existsSync(this.pluginDir)) {
      try {
        fs.mkdirSync(this.pluginDir, { recursive: true });
      } catch {
        return [];
      }
    }

    const loaded: string[] = [];
    const files = fs.readdirSync(this.pluginDir).filter((f) => f.endsWith(".js") && !f.endsWith(".d.ts"));

    for (const file of files) {
      const fullPath = path.join(this.pluginDir, file);
      try {
        // Bust require cache so plugins are genuinely hot-swappable without process restart
        delete require.cache[require.resolve(fullPath)];
        const mod = require(fullPath);
        const StrategyClass = mod.default || mod.Strategy || Object.values(mod).find((v) => typeof v === "function");
        const pluginName = String(mod.strategyName || path.basename(file, ".js")).toLowerCase();

        if (typeof StrategyClass === "function") {
          this.plugins.set(pluginName, StrategyClass as StrategyConstructor);
          loaded.push(pluginName);
          console.log(`[PluginLoader] Loaded hot-swappable strategy plugin: ${pluginName}`);
        }
      } catch (err: any) {
        console.warn(`[PluginLoader] Failed loading plugin ${file}:`, err.message);
      }
    }

    return loaded;
  }

  public static get(name: string): StrategyConstructor | undefined {
    if (this.plugins.size === 0) {
      this.loadAll();
    }
    return this.plugins.get(name.toLowerCase());
  }

  public static list(): string[] {
    return Array.from(this.plugins.keys());
  }
}
