import crypto from "node:crypto";
import WebSocket, { type RawData } from "ws";

const WFM_WS_URL = "wss://ws.warframe.market/socket";
const WFM_WS_PROTOCOL = "wfm";
const WFM_WS_ORIGIN = "https://warframe.market";
export const WFM_WS_TIMEOUT_MS = 15_000;
const WFM_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

function generateWfmWsId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(11), (b) => chars[b % chars.length]).join("");
}

export function createWfmWebSocket(options: { handshakeTimeout?: number } = {}): WebSocket {
  return new WebSocket(WFM_WS_URL, WFM_WS_PROTOCOL, {
    origin: WFM_WS_ORIGIN,
    handshakeTimeout: options.handshakeTimeout,
    maxPayload: WFM_WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });
}

export function sendWfmWsMessage(
  socket: WebSocket,
  route: string,
  payload: Record<string, unknown>,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ route, payload, id: generateWfmWsId() }));
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
