import tls from "node:tls";
import crypto from "node:crypto";
import { withScope } from "./logger";
import {
  MAX_WFM_WS_FRAME_BYTES,
  encodeWfmWsFrame,
  generateWfmWsId,
  parseWfmWsFrame,
} from "./wfmWsProtocol";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { WfmStatus } from "../config/shared/wfm";

const log = withScope("wfmWebSocket");

/**
 * wfmWebSocket.ts — Minimal WebSocket client for WFM status updates.
 *
 * WFM status can ONLY be set via WebSocket (wss://ws.warframe.market/socket),
 * not via the REST API. This module implements a single-use, connection-per-call
 * WebSocket flow:
 *   1. TLS connect to ws.warframe.market:443
 *   2. HTTP Upgrade to WebSocket (protocol: wfm)
 *   3. Send   @wfm|cmd/auth/signIn  { token }
 *   4. Receive @wfm|cmd/auth/signIn:ok
 *   5. Send   @wfm|cmd/status/set   { status }
 *   6. Receive @wfm|cmd/status/set:ok
 *   7. Send WebSocket close frame and let the socket close naturally
 *
 * No external npm packages required — only Node.js built-ins.
 */

const WS_HOST = "ws.warframe.market";
const WS_PORT = 443;
const WS_PATH = "/socket";
const WS_PROTOCOL = "wfm";
const WS_TIMEOUT = 15000;
const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WFM_WS_BUFFER_BYTES = 4 * MAX_WFM_WS_FRAME_BYTES;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Connect to WFM WebSocket, authenticate, and set user status.
 *
 * @param token  Authenticated JWT (never leaves main process)
 * @param status
 * @returns Resolves when status is confirmed set by server
 */
export function setStatusViaWebSocket(token: string, status: WfmStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let upgraded = false;
    let wsBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let httpAccum = "";
    let statusOk = false;
    let expectedWsAccept = "";

    function done(err?: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (destroyErr) {
        log.warn("[WFMWebSocket] socket.destroy failed:", normalizeErrorMessage(destroyErr));
      }
      if (err) reject(err);
      else resolve();
    }

    const timer = setTimeout(
      () => done(statusOk ? null : new Error("WFM WebSocket timeout")),
      WS_TIMEOUT,
    );

    const socket = tls.connect({ host: WS_HOST, port: WS_PORT, servername: WS_HOST }, () => {
      const wsKey = crypto.randomBytes(16).toString("base64");
      expectedWsAccept = crypto
        .createHash("sha1")
        .update(wsKey + WS_ACCEPT_GUID, "utf8")
        .digest("base64");
      socket.write(
        `GET ${WS_PATH} HTTP/1.1\r\n` +
          `Host: ${WS_HOST}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${wsKey}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Protocol: ${WS_PROTOCOL}\r\n` +
          `Origin: https://warframe.market\r\n` +
          `\r\n`,
      );
    });

    function sendWs(obj: object): void {
      socket.write(encodeWfmWsFrame(JSON.stringify(obj)));
    }

    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        httpAccum += chunk.toString("binary");
        const hdrEnd = httpAccum.indexOf("\r\n\r\n");
        if (hdrEnd < 0) return;

        const headerBlock = httpAccum.slice(0, hdrEnd);
        const headerLines = headerBlock.split("\r\n");
        const statusLine = headerLines[0] || "";
        if (!/^HTTP\/1\.[01]\s+101\b/i.test(statusLine)) {
          done(new Error("WS upgrade failed: " + statusLine));
          return;
        }

        const headers = new Map<string, string>();
        for (const line of headerLines.slice(1)) {
          const idx = line.indexOf(":");
          if (idx <= 0) continue;
          const key = line.slice(0, idx).trim().toLowerCase();
          const val = line.slice(idx + 1).trim();
          headers.set(key, val);
        }

        const upgradeHdr = (headers.get("upgrade") || "").toLowerCase();
        const connHdr = headers.get("connection") || "";
        const protocolHdr = (headers.get("sec-websocket-protocol") || "").toLowerCase();
        const acceptHdr = headers.get("sec-websocket-accept") || "";

        if (upgradeHdr !== "websocket") {
          done(new Error("WS upgrade failed: invalid Upgrade header"));
          return;
        }
        if (!/\bupgrade\b/i.test(connHdr)) {
          done(new Error("WS upgrade failed: invalid Connection header"));
          return;
        }
        if (protocolHdr !== WS_PROTOCOL) {
          done(new Error(`WS upgrade failed: unexpected protocol "${protocolHdr || "(none)"}"`));
          return;
        }
        if (!expectedWsAccept || acceptHdr !== expectedWsAccept) {
          done(new Error("WS upgrade failed: invalid Sec-WebSocket-Accept"));
          return;
        }

        upgraded = true;
        wsBuf = Buffer.from(httpAccum.slice(hdrEnd + 4), "binary");
        httpAccum = "";
        if (wsBuf.length > MAX_WFM_WS_BUFFER_BYTES) {
          done(new Error("WS buffer exceeded maximum size during upgrade"));
          return;
        }

        sendWs({ route: "@wfm|cmd/auth/signIn", payload: { token }, id: generateWfmWsId() });
      } else {
        wsBuf = Buffer.concat([wsBuf, chunk]);
        if (wsBuf.length > MAX_WFM_WS_BUFFER_BYTES) {
          done(new Error("WS buffer exceeded maximum size"));
          return;
        }
      }

      try {
        for (;;) {
          const frame = parseWfmWsFrame(wsBuf);
          if (!frame) break;
          wsBuf = frame.rest;

          const { opcode, text } = frame;

          if (opcode === 8) {
            done(statusOk ? null : new Error("Server closed WS before status was set"));
            return;
          }
          if (opcode === 9) {
            socket.write(Buffer.from([0x8a, 0x80, 0x00, 0x00, 0x00, 0x00]));
            continue;
          }
          if (opcode !== 1) continue;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped WFM websocket message
          let msg: any;
          try {
            msg = JSON.parse(text);
          } catch {
            continue;
          }

          const route: string = msg.route || "";
          log.log("[WFMWebSocket] ←", route);

          if (route.endsWith(":error")) {
            done(new Error(`WFM WS error: ${route} — ${JSON.stringify(msg.payload)}`));
            return;
          }

          if (route.includes("auth/signIn:ok")) {
            sendWs({ route: "@wfm|cmd/status/set", payload: { status }, id: generateWfmWsId() });
          } else if (route.includes("status/set:ok")) {
            statusOk = true;
            socket.write(Buffer.from([0x88, 0x80, 0x00, 0x00, 0x00, 0x00]));
          }
        }
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on("error", (err: Error) => done(err));
    socket.on("close", () => done(statusOk ? null : new Error("WS closed unexpectedly")));
  });
}
