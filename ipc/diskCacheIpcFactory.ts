/**
 * Factory for disk-backed JSON cache IPC handlers.
 *
 * Each cache pair exposes two IPC channels:
 *   - `<prefix>:load`  - reads a JSON file from `userData` and returns its contents
 *   - `<prefix>:save`  - writes a JSON blob to the same file
 *
 * All handlers enforce sender authorization via `assertMainRendererSender`.
 */

import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { withScope, type ScopedLogger } from "../services/logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

interface DiskCacheIpcConfig {
  /** Logger scope name, e.g. `"priceCacheIpc"`. */
  scope: string;
  /** File stored in `app.getPath("userData")`, e.g. `"price-cache.json"`. */
  filename: string;
  /** IPC channel prefix, e.g. `"price-cache"`.  Registers `:load` and `:save`. */
  channelPrefix: string;
  /** Human-readable noun for log messages, e.g. `"price cache"`. */
  noun: string;
  /**
   * Maximum serialized payload size in bytes. Save calls exceeding this limit
   * are rejected to prevent a compromised renderer from exhausting disk.
   * Defaults to 64 MiB (snapshot cache is ~2 MiB today, so 30x headroom).
   */
  maxPayloadBytes?: number;
  /**
   * Maximum top-level key count. Rejects absurdly large objects even if their
   * serialized size fits. Defaults to 200_000 (snapshot has ~13k top-level keys).
   */
  maxKeyCount?: number;
  /** Optional cache-specific shape validator applied on load and save. */
  validateData?: (data: Record<string, unknown>) => boolean;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_KEY_COUNT = 200_000;

/**
 * Create a `{ register }` object that, when `register()` is called, installs
 * `:load` and `:save` IPC handlers for a JSON cache file on disk.
 */
function createDiskCacheIpc(config: DiskCacheIpcConfig): { register: () => void } {
  const { scope, filename, channelPrefix, noun } = config;
  const maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const maxKeyCount = config.maxKeyCount ?? DEFAULT_MAX_KEY_COUNT;
  const log: ScopedLogger = withScope(scope);

  function getCachePath(): string {
    return path.join(app.getPath("userData"), filename);
  }

  function register(): void {
    handleAuthorized(`${channelPrefix}:load`, assertMainRendererSender, async () => {
      try {
        const filePath = getCachePath();
        if (!fs.existsSync(filePath)) return null;

        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        if (config.validateData && !config.validateData(parsed as Record<string, unknown>)) {
          log.warn(`Ignoring invalid ${noun} shape from disk`);
          return null;
        }

        log.info(`Loaded ${noun} from disk (${Object.keys(parsed as object).length} entries)`);
        return parsed as Record<string, unknown>;
      } catch (err) {
        log.warn(`Failed to load ${noun}:`, normalizeErrorMessage(err));
        return null;
      }
    });

    handleAuthorized(
      `${channelPrefix}:save`,
      assertMainRendererSender,
      async (_event, data: unknown) => {
        try {
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            return { ok: false };
          }
          if (config.validateData && !config.validateData(data as Record<string, unknown>)) {
            log.warn(`Refusing ${noun} save: invalid shape`);
            return { ok: false };
          }

          const keyCount = Object.keys(data as Record<string, unknown>).length;
          if (keyCount > maxKeyCount) {
            log.warn(`Refusing ${noun} save: ${keyCount} keys exceeds limit ${maxKeyCount}`);
            return { ok: false };
          }

          const serialized = JSON.stringify(data);
          const payloadBytes = Buffer.byteLength(serialized, "utf-8");
          if (payloadBytes > maxPayloadBytes) {
            log.warn(
              `Refusing ${noun} save: ${payloadBytes} bytes exceeds limit ${maxPayloadBytes}`,
            );
            return { ok: false };
          }

          const filePath = getCachePath();
          fs.writeFileSync(filePath, serialized, "utf-8");
          return { ok: true };
        } catch (err) {
          log.error(`Failed to save ${noun}:`, normalizeErrorMessage(err));
          return { ok: false };
        }
      },
    );
  }

  return { register };
}

export { createDiskCacheIpc };
