import WebSocket from "ws";

import { normalizeErrorMessage } from "../config/shared/errors";
import type { WfmStatus } from "../config/shared/wfm";
import { withScope } from "./logger";
import {
  WFM_WS_TIMEOUT_MS,
  createWfmWebSocket,
  parseWfmWsMessage,
  sendWfmWsMessage,
} from "./wfmWebSocketCommon";

const log = withScope("wfmWebSocket");

export function setStatusViaWebSocket(token: string, status: WfmStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let statusOk = false;
    const socket = createWfmWebSocket({ handshakeTimeout: WFM_WS_TIMEOUT_MS });

    const timer = setTimeout(() => {
      done(new Error("WFM WebSocket timeout"));
    }, WFM_WS_TIMEOUT_MS);

    function closeSocket(): void {
      try {
        if (
          socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.OPEN
        ) {
          socket.close(1000);
        }
      } catch (err) {
        log.warn("[WFMWebSocket] socket.close failed:", normalizeErrorMessage(err));
      }
    }

    function done(err?: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSocket();
      if (err) reject(err);
      else resolve();
    }

    socket.on("open", () => {
      sendWfmWsMessage(socket, "@wfm|cmd/auth/signIn", { token });
    });

    socket.on("message", (data) => {
      const msg = parseWfmWsMessage(data);
      if (!msg) return;

      const route = typeof msg.route === "string" ? msg.route : "";
      log.info("[WFMWebSocket] <-", route);

      if (route.endsWith(":error")) {
        done(new Error(`WFM WS error: ${route} - ${JSON.stringify(msg.payload)}`));
        return;
      }

      if (route.includes("auth/signIn:ok")) {
        sendWfmWsMessage(socket, "@wfm|cmd/status/set", { status });
        return;
      }

      if (route.includes("status/set:ok")) {
        statusOk = true;
        done(null);
      }
    });

    socket.on("error", (err) => {
      done(err instanceof Error ? err : new Error(normalizeErrorMessage(err)));
    });

    socket.on("close", () => {
      done(statusOk ? null : new Error("WS closed unexpectedly"));
    });
  });
}
