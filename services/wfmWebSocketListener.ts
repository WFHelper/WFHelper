import tls from "node:tls";
import crypto from "node:crypto";
import { withScope } from "./logger";
import { encodeWfmWsFrame, generateWfmWsId, parseWfmWsFrame } from "./wfmWsProtocol";

import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("wfmWebSocketListener");

/**
 * wfmWebSocketListener.ts — Persistent WFM WebSocket listener for DM/trade notifications.
 *
 * Connects, authenticates, then listens for incoming messages indefinitely.
 * Reconnects with exponential backoff (1 s → 2 s → 4 s … 60 s cap) on any disconnect.
 * Token is only used in the main process; it never crosses IPC.
 */

const WS_HOST = "ws.warframe.market";
const WS_PORT = 443;
const WS_PATH = "/socket";
const WS_PROTOCOL = "wfm";
const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const RECONNECT_JITTER_MS = 500;
const PING_INTERVAL_MS = 30_000;


let _active = false;
let _token: string | null = null;
let _onEvent: ((type: string, payload: unknown) => void) | null = null;
let _reconnectAttempt = 0;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _socket: ReturnType<typeof tls.connect> | null = null;
let _pingTimer: ReturnType<typeof setInterval> | null = null;


function _clearTimers(): void {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_pingTimer) {
    clearInterval(_pingTimer);
    _pingTimer = null;
  }
}

function _destroySocket(): void {
  if (_socket) {
    try {
      _socket.destroy();
    } catch {
      // ignore
    }
    _socket = null;
  }
}

function _reconnectDelay(): number {
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, _reconnectAttempt), RECONNECT_CAP_MS);
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  return base + jitter;
}

function _scheduleReconnect(): void {
  if (!_active) return;
  _clearTimers();
  _destroySocket();

  const delay = _reconnectDelay();
  _reconnectAttempt++;
  log.log(
    `[WFMListener] Reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`,
  );
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_active && _token) _connect(_token);
  }, delay);
}

function _connect(token: string): void {
  if (!_active) return;

  _destroySocket();

  let upgraded = false;
  let wsBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let httpAccum = "";
  let expectedWsAccept = "";

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

  _socket = socket;

  function sendWs(obj: object): void {
    if (!socket.destroyed) socket.write(encodeWfmWsFrame(JSON.stringify(obj)));
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
        log.warn("[WFMListener] Upgrade rejected:", statusLine);
        _scheduleReconnect();
        return;
      }

      const headers = new Map<string, string>();
      for (const line of headerLines.slice(1)) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
      }

      if (
        (headers.get("upgrade") || "").toLowerCase() !== "websocket" ||
        !/\bupgrade\b/i.test(headers.get("connection") || "") ||
        (headers.get("sec-websocket-protocol") || "").toLowerCase() !== WS_PROTOCOL ||
        (headers.get("sec-websocket-accept") || "") !== expectedWsAccept
      ) {
        log.warn("[WFMListener] Bad upgrade headers");
        _scheduleReconnect();
        return;
      }

      upgraded = true;
      wsBuf = Buffer.from(httpAccum.slice(hdrEnd + 4), "binary");
      httpAccum = "";

      sendWs({ route: "@wfm|cmd/auth/signIn", payload: { token }, id: generateWfmWsId() });

      // Keepalive pings
      _pingTimer = setInterval(() => {
        if (!socket.destroyed) {
          // Send a WebSocket ping frame (opcode 0x9), masked, zero payload
          socket.write(Buffer.from([0x89, 0x80, 0x00, 0x00, 0x00, 0x00]));
        }
      }, PING_INTERVAL_MS);
      const pingTimerRef = _pingTimer as { unref?: () => void } | null;
      if (typeof pingTimerRef?.unref === "function") {
        pingTimerRef.unref();
      }
    } else {
      wsBuf = Buffer.concat([wsBuf, chunk]);
    }

    for (;;) {
      const frame = parseWfmWsFrame(wsBuf);
      if (!frame) break;
      wsBuf = frame.rest;

      const { opcode, text } = frame;

      if (opcode === 8) {
        // Server-initiated close
        log.log("[WFMListener] Server sent close frame");
        _scheduleReconnect();
        return;
      }
      if (opcode === 9) {
        // Ping → send pong
        socket.write(Buffer.from([0x8a, 0x80, 0x00, 0x00, 0x00, 0x00]));
        continue;
      }
      if (opcode === 0xa) continue; // pong, ignore
      if (opcode !== 1) continue;   // non-text, skip

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }

      const route: string = typeof msg.route === "string" ? msg.route : "";
      log.log("[WFMListener] ←", route);

      if (route.endsWith(":error")) {
        log.warn("[WFMListener] Server error:", route, JSON.stringify(msg.payload));
        continue;
      }

      if (route.includes("auth/signIn:ok")) {
        _reconnectAttempt = 0; // reset backoff on successful auth
        log.log("[WFMListener] Authenticated, listening for events");
        continue;
      }

      // Forward all non-auth events to the caller
      if (_onEvent && route && !route.includes("auth/")) {
        try {
          _onEvent(route, msg.payload ?? null);
        } catch (cbErr) {
          log.warn("[WFMListener] onEvent callback threw:", normalizeErrorMessage(cbErr));
        }
      }
    }
  });

  socket.on("error", (err: Error) => {
    log.warn("[WFMListener] Socket error:", normalizeErrorMessage(err));
    _scheduleReconnect();
  });

  socket.on("close", () => {
    if (_active) {
      log.log("[WFMListener] Socket closed, will reconnect");
      _scheduleReconnect();
    }
  });
}


/**
 * Start the persistent WFM WebSocket listener.
 * Safe to call multiple times — stops any existing session first.
 *
 * @param token  JWT from wfmSession (main-process only, never sent to renderer)
 * @param onEvent  Called for each incoming WS event (route, payload)
 */
export function startListening(
  token: string,
  onEvent: (type: string, payload: unknown) => void,
): void {
  stopListening();
  _active = true;
  _token = token;
  _onEvent = onEvent;
  _reconnectAttempt = 0;
  log.log("[WFMListener] Starting");
  _connect(token);
}

/**
 * Stop the persistent listener and cancel any pending reconnect.
 */
export function stopListening(): void {
  _active = false;
  _token = null;
  _onEvent = null;
  _clearTimers();
  _destroySocket();
  _reconnectAttempt = 0;
  log.log("[WFMListener] Stopped");
}
