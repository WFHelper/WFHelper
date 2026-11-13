import WebSocket from "ws";

import { normalizeErrorMessage } from "../config/shared/errors";
import { refreshWfmClearance } from "./wfmClient";
import { withScope } from "./logger";
import { createWfmWebSocket, parseWfmWsMessage, sendWfmWsMessage } from "./wfmWebSocketCommon";

const log = withScope("wfmWebSocketListener");

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 60_000;
const RECONNECT_JITTER_MS = 500;
const PING_INTERVAL_MS = 30_000;
// Retry transient sign-in failures, but stop after repeated token rejection.
const MAX_SIGNIN_FAILURES = 3;

let _active = false;
let _token: string | null = null;
let _onEvent: ((type: string, payload: unknown) => void) | null = null;
let _onAuthGiveUp: (() => void) | null = null;
let _reconnectAttempt = 0;
let _stableTimer: ReturnType<typeof setTimeout> | null = null;
const STABLE_AFTER_MS = 60_000;
let _signInFailures = 0;
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

function _clearStableTimer(): void {
  if (_stableTimer) clearTimeout(_stableTimer);
  _stableTimer = null;
}

function _scheduleReconnect(): void {
  if (!_active) return;
  _clearStableTimer();
  _clearTimers();
  _destroySocket();

  const delay = _reconnectDelay();
  _reconnectAttempt++;
  log.info(`[WFMListener] Reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_active && _token) _connect(_token);
  }, delay);
}

function _connect(token: string): void {
  if (!_active) return;

  _destroySocket();
  let reconnecting = false;
  const socket = createWfmWebSocket();

  _socket = socket;

  const reconnect = (): void => {
    if (reconnecting) return;
    reconnecting = true;
    _scheduleReconnect();
  };

  socket.on("unexpected-response", (_request, response) => {
    if (response.statusCode !== 403 || reconnecting) return;
    reconnecting = true;
    response.resume();
    _request.abort();
    log.warn("[WFMListener] WebSocket handshake rejected (403); refreshing Cloudflare clearance");
    void refreshWfmClearance()
      .then((refreshed) => {
        if (!_active) return;
        if (refreshed) {
          log.info("[WFMListener] Clearance refreshed; retrying websocket connection");
          _scheduleReconnect();
        } else {
          log.warn("[WFMListener] Clearance refresh failed; stopping websocket retries");
          stopListening();
        }
      })
      .catch((err) => {
        log.warn("[WFMListener] Clearance refresh failed:", normalizeErrorMessage(err));
        if (_active) stopListening();
      });
  });

  socket.on("open", () => {
    sendWfmWsMessage(socket, "@wfm|cmd/auth/signIn", { token });
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
    log.info("[WFMListener] <-", route);

    if (route.endsWith(":error")) {
      log.warn("[WFMListener] Server error:", route, JSON.stringify(msg.payload));
      if (route.includes("auth/signIn")) {
        _signInFailures++;
        if (_signInFailures >= MAX_SIGNIN_FAILURES) {
          log.warn(
            "[WFMListener] Sign-in rejected repeatedly - stopping until the next manual login",
          );
          const notifyGiveUp = _onAuthGiveUp;
          stopListening();
          notifyGiveUp?.();
        } else {
          reconnect();
        }
      }
      return;
    }

    if (route.includes("auth/signIn:ok")) {
      _signInFailures = 0;
      // Backoff resets once the socket has held, not here: a server that
      // authenticates and then closes would otherwise reconnect every second.
      _clearStableTimer();
      _stableTimer = setTimeout(() => {
        _stableTimer = null;
        _reconnectAttempt = 0;
      }, STABLE_AFTER_MS);
      log.info("[WFMListener] Authenticated, listening for events");
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
      log.info("[WFMListener] Socket closed, will reconnect");
      reconnect();
    }
  });
}

export function startListening(
  token: string,
  onEvent: (type: string, payload: unknown) => void,
  onAuthGiveUp?: () => void,
): void {
  stopListening();
  _active = true;
  _token = token;
  _onEvent = onEvent;
  _onAuthGiveUp = onAuthGiveUp ?? null;
  _reconnectAttempt = 0;
  _signInFailures = 0;
  log.info("[WFMListener] Starting");
  _connect(token);
}

/** WFM rotates the session token on ordinary responses; without this the next
 *  reconnect would present the dead one and the listener would give up. */
export function updateListenerToken(token: string): void {
  if (!_active || !token || token === _token) return;
  _token = token;
}

export function stopListening(): void {
  _active = false;
  _token = null;
  _onEvent = null;
  _onAuthGiveUp = null;
  _clearStableTimer();
  _clearTimers();
  _destroySocket();
  _reconnectAttempt = 0;
  log.info("[WFMListener] Stopped");
}
