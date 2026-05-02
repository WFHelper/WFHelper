import crypto from "node:crypto";
import type { RawData } from "ws";

export const WFM_WS_URL = "wss://ws.warframe.market/socket";
export const WFM_WS_PROTOCOL = "wfm";
export const WFM_WS_ORIGIN = "https://warframe.market";
export const WFM_WS_TIMEOUT_MS = 15_000;
export const WFM_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

export function generateWfmWsId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(11), (b) => chars[b % chars.length]).join("");
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

export function parseWfmWsMessage(data: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawDataToString(data));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
