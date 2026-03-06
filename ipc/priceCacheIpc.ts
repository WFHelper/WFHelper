import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { createRuntimeRequire } from "./runtimeRequire";

export {};

const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = requireRuntime<{
  withScope: (scope: string) => {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}>("services/logger").withScope("priceCacheIpc");

const { ipcMain, app } = require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");

const CACHE_FILENAME = "price-cache.json";

function getCachePath(): string {
  return path.join(app.getPath("userData"), CACHE_FILENAME);
}

function register(): void {
  ipcMain.handle("price-cache:load", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "price-cache:load");

    try {
      const filePath = getCachePath();
      if (!fs.existsSync(filePath)) return null;

      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

      log.log(`Loaded price cache from disk (${Object.keys(parsed as object).length} entries)`);
      return parsed as Record<string, unknown>;
    } catch (err) {
      log.warn(
        "Failed to load price cache:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  });

  ipcMain.handle("price-cache:save", async (event: unknown, data: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "price-cache:save");

    try {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: false };
      }

      const filePath = getCachePath();
      fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
      return { ok: true };
    } catch (err) {
      log.error(
        "Failed to save price cache:",
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false };
    }
  });
}

export { register };

module.exports = { register };
