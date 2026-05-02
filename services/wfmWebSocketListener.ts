import WebSocket from "ws";

import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "./logger";
import {
  WFM_WS_MAX_PAYLOAD_BYTES,
  WFM_WS_ORIGIN,
  WFM_WS_PROTOCOL,
  WFM_WS_URL,
  generateWfmWsId,
  parseWfmWsMessage,
} from "./wfmWebSocketCommon";

const log = withScope("wfmWebSocketListener");

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const RECONNECT_JITTER_MS = 500;
const PING_INTERVAL_MS = 30_000;

let _active = false;
let _token: string | null = null;
let _onEvent: ((type: string, payload: unknown) => void) | null = null;
let _reconnectAttempt = 0;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _socket: WebSocket | null = null;
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
  if (!_socket) return;
  try {
    if (_socket.readyState === WebSocket.OPEN || _socket.readyState === WebSocket.CONNECTING) {
      _socket.terminate();
    }
  } catch {
    /* ignore */
  }
  _socket = null;
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
  log.log(`[WFMListener] Reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_active && _token) _connect(_token);
  }, delay);
}

function _sendWfm(socket: WebSocket, route: string, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ route, payload, id: generateWfmWsId() }));
}

function _connect(token: string): void {
  if (!_active) return;

  _destroySocket();
  let reconnecting = false;
  const socket = new WebSocket(WFM_WS_URL, WFM_WS_PROTOCOL, {
    origin: WFM_WS_ORIGIN,
    maxPayload: WFM_WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  _socket = socket;

  const reconnect = (): void => {
    if (reconnecting) return;
    reconnecting = true;
    _scheduleReconnect();
  };

  socket.on("open", () => {
    _sendWfm(socket, "@wfm|cmd/auth/signIn", { token });
    _pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, PING_INTERVAL_MS);
    const pingTimerRef = _pingTimer as { unref?: () => void } | null;
    if (typeof pingTimerRef?.unref === "function") pingTimerRef.unref();
  });

  socket.on("message", (data) => {
    const msg = parseWfmWsMessage(data);
    if (!msg) return;

    const route = typeof msg.route === "string" ? msg.route : "";
    log.log("[WFMListener] <-", route);

    if (route.endsWith(":error")) {
      log.warn("[WFMListener] Server error:", route, JSON.stringify(msg.payload));
      return;
    }

    if (route.includes("auth/signIn:ok")) {
      _reconnectAttempt = 0;
      log.log("[WFMListener] Authenticated, listening for events");
      return;
    }

    if (_onEvent && route && !route.includes("auth/")) {
      try {
        _onEvent(route, msg.payload ?? null);
      } catch (err) {
        log.warn("[WFMListener] onEvent callback threw:", normalizeErrorMessage(err));
      }
    }
  });

  socket.on("error", (err) => {
    log.warn("[WFMListener] Socket error:", normalizeErrorMessage(err));
    reconnect();
  });

  socket.on("close", () => {
    if (_active) {
      log.log("[WFMListener] Socket closed, will reconnect");
      reconnect();
    }
  });
}

export function startListening(token: string, onEvent: (type: string, payload: unknown) => void): void {
  stopListening();
  _active = true;
  _token = token;
  _onEvent = onEvent;
  _reconnectAttempt = 0;
  log.log("[WFMListener] Starting");
  _connect(token);
}

export function stopListening(): void {
  _active = false;
  _token = null;
  _onEvent = null;
  _clearTimers();
  _destroySocket();
  _reconnectAttempt = 0;
  log.log("[WFMListener] Stopped");
}
