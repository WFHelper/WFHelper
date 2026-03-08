/**
 * Factory for disk-backed JSON cache IPC handlers.
 *
 * Each cache pair exposes two IPC channels:
 *   - `<prefix>:load`  — reads a JSON file from `userData` and returns its contents
 *   - `<prefix>:save`  — writes a JSON blob to the same file
 *
 * All handlers enforce sender authorization via `assertMainRendererSender`.
 */

import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { createRuntimeRequire } from "./runtimeRequire";
import { withScope, type ScopedLogger } from "../services/logger";


const requireRuntime = createRuntimeRequire(__dirname, 1);

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const { ipcMain, app } = require("electron") as typeof import("electron");
const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");

export interface DiskCacheIpcConfig {
  /** Logger scope name, e.g. `"priceCacheIpc"`. */
  scope: string;
  /** File stored in `app.getPath("userData")`, e.g. `"price-cache.json"`. */
  filename: string;
  /** IPC channel prefix, e.g. `"price-cache"`.  Registers `:load` and `:save`. */
  channelPrefix: string;
  /** Human-readable noun for log messages, e.g. `"price cache"`. */
  noun: string;
}

/**
 * Create a `{ register }` object that, when `register()` is called, installs
 * `:load` and `:save` IPC handlers for a JSON cache file on disk.
 */
function createDiskCacheIpc(config: DiskCacheIpcConfig): { register: () => void } {
  const { scope, filename, channelPrefix, noun } = config;
  const log: ScopedLogger = withScope(scope);

  function getCachePath(): string {
    return path.join(app.getPath("userData"), filename);
  }

  function register(): void {
    ipcMain.handle(`${channelPrefix}:load`, async (event: unknown) => {
      assertAuthorizedSender(assertMainRendererSender, event as never, `${channelPrefix}:load`);

      try {
        const filePath = getCachePath();
        if (!fs.existsSync(filePath)) return null;

        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

        log.log(`Loaded ${noun} from disk (${Object.keys(parsed as object).length} entries)`);
        return parsed as Record<string, unknown>;
      } catch (err) {
        log.warn(`Failed to load ${noun}:`, normalizeErrorMessage(err));
        return null;
      }
    });

    ipcMain.handle(`${channelPrefix}:save`, async (event: unknown, data: unknown) => {
      assertAuthorizedSender(assertMainRendererSender, event as never, `${channelPrefix}:save`);

      try {
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return { ok: false };
        }

        const filePath = getCachePath();
        fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
        return { ok: true };
      } catch (err) {
        log.error(`Failed to save ${noun}:`, normalizeErrorMessage(err));
        return { ok: false };
      }
    });
  }

  return { register };
}

export { createDiskCacheIpc };
