"use strict";

const log = require("./logger").withScope("wfmWebSocket");
const { normalizeErrorMessage } = require("../config/shared/errors.cjs");

/**
 * wfmWebSocket.js — Minimal WebSocket client for WFM status updates.
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

const tls = require("tls");
const crypto = require("crypto");

const WS_HOST = "ws.warframe.market";
const WS_PORT = 443;
const WS_PATH = "/socket";
const WS_PROTOCOL = "wfm";
const WS_TIMEOUT = 15000;
const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate an 11-character alphanumeric message ID. */
function _genId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(11), (b) => chars[b % chars.length]).join("");
}

/**
 * Encode a UTF-8 string as a masked WebSocket text frame (client → server).
 * Client frames MUST be masked per RFC 6455.
 */
function _encodeFrame(text) {
  const payload = Buffer.from(text, "utf-8");
  const len = payload.length;
  const mask = crypto.randomBytes(4);

  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 0xfe;
    header.writeUInt16BE(len, 2);
  } else {
    throw new Error("WS frame payload too large");
  }

  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];

  return Buffer.concat([header, mask, masked]);
}

/**
 * Attempt to parse the next WebSocket frame from buf.
 * Server → client frames are NEVER masked.
 * Returns { opcode, text, rest } or null if buf is incomplete.
 */
function _parseFrame(buf) {
  if (buf.length < 2) return null;

  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payLen = buf[1] & 0x7f;
  let offset = 2;

  if (payLen === 126) {
    if (buf.length < 4) return null;
    payLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payLen === 127) {
    if (buf.length < 10) return null;
    payLen = buf.readUInt32BE(6); // ignore high 4 bytes; msgs are small
    offset = 10;
  }

  const maskBytes = masked ? 4 : 0;
  const total = offset + maskBytes + payLen;
  if (buf.length < total) return null;

  let payload;
  if (masked) {
    const mk = buf.slice(offset, offset + 4);
    payload = Buffer.allocUnsafe(payLen);
    for (let i = 0; i < payLen; i++) payload[i] = buf[offset + 4 + i] ^ mk[i % 4];
  } else {
    payload = buf.slice(offset, offset + payLen);
  }

  return { opcode, text: payload.toString("utf-8"), rest: buf.slice(total) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Connect to WFM WebSocket, authenticate, and set user status.
 *
 * @param {string} token  Authenticated JWT (never leaves main process)
 * @param {"online"|"ingame"|"invisible"} status
 * @returns {Promise<void>} Resolves when status is confirmed set by server
 */
function setStatusViaWebSocket(token, status) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let upgraded = false;
    let wsBuf = Buffer.alloc(0);
    let httpAccum = "";
    let statusOk = false; // server confirmed @wfm|cmd/status/set:ok
    let expectedWsAccept = "";

    function done(err) {
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

    // If status was already confirmed but close handshake stalls, still resolve
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

    function sendWs(obj) {
      socket.write(_encodeFrame(JSON.stringify(obj)));
    }

    socket.on("data", (chunk) => {
      if (!upgraded) {
        // Accumulate the HTTP response as a binary string until end-of-headers
        httpAccum += chunk.toString("binary");
        const hdrEnd = httpAccum.indexOf("\r\n\r\n");
        if (hdrEnd < 0) return; // headers not yet complete

        const headerBlock = httpAccum.slice(0, hdrEnd);
        const headerLines = headerBlock.split("\r\n");
        const statusLine = headerLines[0] || "";
        if (!/^HTTP\/1\.[01]\s+101\b/i.test(statusLine)) {
          done(new Error("WS upgrade failed: " + statusLine));
          return;
        }

        const headers = new Map();
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
        // Bytes after the HTTP headers are the start of the WebSocket stream
        wsBuf = Buffer.from(httpAccum.slice(hdrEnd + 4), "binary");
        httpAccum = "";

        // Step 3 — authenticate
        sendWs({ route: "@wfm|cmd/auth/signIn", payload: { token }, id: _genId() });
      } else {
        wsBuf = Buffer.concat([wsBuf, chunk]);
      }

      // Process all complete WebSocket frames
      for (;;) {
        const frame = _parseFrame(wsBuf);
        if (!frame) break;
        wsBuf = frame.rest;

        const { opcode, text } = frame;

        if (opcode === 8) {
          // Close frame from server
          done(statusOk ? null : new Error("Server closed WS before status was set"));
          return;
        }
        if (opcode === 9) {
          // Ping → reply with Pong (masked, no payload)
          socket.write(Buffer.from([0x8a, 0x80, 0x00, 0x00, 0x00, 0x00]));
          continue;
        }
        if (opcode !== 1) continue; // Not a text frame — skip

        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }

        const route = msg.route || "";
        log.log("[WFMWebSocket] ←", route);

        if (route.endsWith(":error")) {
          done(new Error(`WFM WS error: ${route} — ${JSON.stringify(msg.payload)}`));
          return;
        }

        if (route.includes("auth/signIn:ok")) {
          // Step 5 — set status
          sendWs({ route: "@wfm|cmd/status/set", payload: { status }, id: _genId() });
        } else if (route.includes("status/set:ok")) {
          // Step 7 — graceful close
          statusOk = true;
          socket.write(Buffer.from([0x88, 0x80, 0x00, 0x00, 0x00, 0x00]));
        }
      }
    });

    socket.on("error", (err) => done(err));
    socket.on("close", () => done(statusOk ? null : new Error("WS closed unexpectedly")));
  });
}

module.exports = { setStatusViaWebSocket };
