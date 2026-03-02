const log = require('./logger').withScope('wfmSession');
"use strict";

/**
 * wfmSession.js — Warframe.market session management (main-process only)
 *
 * Handles sign-in, sign-out, and JWT persistence using Electron safeStorage.
 * The raw token NEVER leaves the main process.
 */

const path = require("path");
const fs   = require("fs");
const { app, safeStorage } = require("electron");
const {
  requestRaw,
  requestV2,
  setTokenProvider,
  updateCsrfFromToken,
  clearCsrfToken,
} = require("./wfmClient");
const { setStatusViaWebSocket } = require("./wfmWebSocket");

const SESSION_FILE = () => path.join(app.getPath("userData"), "wfm.session");
const ALLOW_INSECURE_SESSION = process.env.WFM_ALLOW_INSECURE_SESSION === "1";

// ── In-memory state ───────────────────────────────────────────────────────────

let _token    = null;   // JWT string, never exposed to renderer
let _userName = null;   // WFM in-game / profile name
let _platform = "pc";

// Register the token provider so wfmClient can inject the JWT into requests
setTokenProvider(() => _token);

// ── Persistence helpers ───────────────────────────────────────────────────────

function _saveSession(token, userName) {
  try {
    const payload = JSON.stringify({ token, userName, platform: _platform });
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(payload);
      fs.writeFileSync(SESSION_FILE(), encrypted);
      return;
    }

    if (ALLOW_INSECURE_SESSION) {
      // Explicit opt-in only (for unsupported environments).
      // No real security guarantee.
      log.warn("[WFMSession] safeStorage unavailable — insecure base64 session persistence is enabled");
      fs.writeFileSync(SESSION_FILE(), Buffer.from(payload, "utf-8").toString("base64"));
      return;
    }

    // Fail closed by default: keep token in memory only for this app session.
    log.warn("[WFMSession] safeStorage unavailable — session will not be persisted to disk");
  } catch (err) {
    log.error("[WFMSession] Failed to persist session:", err.message);
  }
}

function _clearSession() {
  _token    = null;
  _userName = null;
  clearCsrfToken();
  try {
    if (fs.existsSync(SESSION_FILE())) {
      fs.unlinkSync(SESSION_FILE());
    }
  } catch (err) {
    log.error("[WFMSession] Failed to clear session file:", err.message);
  }
}

function _loadSession() {
  try {
    const file = SESSION_FILE();
    if (!fs.existsSync(file)) return null;

    const raw = fs.readFileSync(file);
    let payload;

    if (safeStorage.isEncryptionAvailable()) {
      payload = safeStorage.decryptString(raw);
    } else if (ALLOW_INSECURE_SESSION) {
      payload = Buffer.from(raw.toString(), "base64").toString("utf-8");
    } else {
      log.warn("[WFMSession] safeStorage unavailable — skipping persisted session restore");
      return null;
    }

    return JSON.parse(payload);
  } catch (err) {
    log.error("[WFMSession] Failed to load session:", err.message);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sign in with email + password.
 * Returns a safe summary (no token) on success.
 * Throws on failure.
 */
async function signIn(email, password) {
  if (!email || !password) {
    throw new Error("Email and password are required.");
  }

  // Diagnostic: log email shape without revealing value
  const atIdx = (email || "").indexOf("@");
  log.log("[WFMSession] signIn email shape — length:", email.length,
    "hasAt:", atIdx > 0,
    "localLen:", atIdx,
    "domainLen:", atIdx > 0 ? email.length - atIdx - 1 : 0,
    "isString:", typeof email === "string"
  );

  // WFM sign-in: POST /v1/auth/signin
  // The JWT is returned either in the Authorization response header,
  // a Set-Cookie "JWT=<token>" header, or the response body.
  const { res, body } = await requestRaw("POST", "/auth/signin", {
    json: { email, password },
  });

  let token = null;

  // 1. Authorization response header ("JWT <token>")
  const authHeader = res.headers.get("authorization");
  if (authHeader) {
    token = authHeader.toLowerCase().startsWith("jwt ")
      ? authHeader.slice(4).trim()
      : authHeader.trim();
  }

  // 2. Set-Cookie header — WFM sets "JWT=<token>; Path=/..."
  if (!token) {
    const setCookie = res.headers.get("set-cookie") || "";
    const match = setCookie.match(/(?:^|,)\s*JWT=([^;,]+)/i);
    if (match) token = match[1].trim();
  }

  // 3. Response body fallback
  if (!token) {
    token = body?.payload?.token
         || body?.token
         || null;
  }

  if (!token) {
    throw new Error("Sign-in succeeded but no session token was returned. Please try again.");
  }

  // Extract user info
  const userInfo = body?.payload?.user || body?.user || {};
  const userName = userInfo.ingame_name || userInfo.name || email.split("@")[0];
  _platform = userInfo.platform || "pc";

  _token    = token;
  _userName = userName;

  // Update the CSRF token from the authenticated JWT payload
  updateCsrfFromToken(token);

  _saveSession(token, userName);

  log.log(`[WFMSession] Signed in as: ${_userName}`);
  return { loggedIn: true, userName: _userName, platform: _platform };
}

/**
 * Sign out and remove persisted session.
 */
function signOut() {
  log.log("[WFMSession] Signing out");
  _clearSession();
  return { loggedIn: false };
}

/**
 * Restore session from disk (called on app startup).
 * Silently ignores missing/corrupt files.
 */
async function restoreSession() {
  const saved = _loadSession();
  if (!saved || !saved.token) {
    log.log("[WFMSession] No persisted session found.");
    return;
  }

  _token    = saved.token;
  _userName = saved.userName || null;
  _platform = saved.platform || "pc";
  updateCsrfFromToken(saved.token);
  log.log(`[WFMSession] Restored session for: ${_userName}`);
}

/**
 * Return a safe session summary for the renderer.
 * Never includes the token.
 */
function getSession() {
  return {
    loggedIn:  !!_token,
    userName:  _userName || null,
    platform:  _platform,
  };
}

/**
 * Return the in-game name (used by wfmOrders to build the profile URL).
 * Internal use only.
 */
function getInGameName() {
  return _userName;
}

/**
 * Fetch current user profile from the v2 API.
 * Returns { id, ingame_name, status, ... } or null.
 */
async function getMe() {
  if (!_token) return null;
  try {
    const data = await requestV2("GET", "/me");
    return data?.data || null;
  } catch (err) {
    log.warn("[WFMSession] getMe failed:", err.message);
    return null;
  }
}

/**
 * Set the authenticated user's online status via WebSocket.
 * (The v2 REST API does not expose a status endpoint — status is
 * managed exclusively through the WFM WebSocket protocol.)
 * @param {"online"|"ingame"|"invisible"} status
 */
async function setStatus(status) {
  if (!_token) throw new Error("Not logged in to Warframe.market.");
  await setStatusViaWebSocket(_token, status);
  return { status };
}

module.exports = { signIn, signOut, restoreSession, getSession, getInGameName, getMe, setStatus };
