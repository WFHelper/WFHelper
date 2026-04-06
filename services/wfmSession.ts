"use strict";

import path from "path";
import fs from "fs";
import { withScope } from "./logger";
const { normalizeErrorMessage } = require("../config/shared/errors.cjs") as {
  normalizeErrorMessage: (err: any) => string;
};

/**
 * wfmSession.ts — Warframe.market session management (main-process only)
 *
 * Handles sign-in, sign-out, and JWT persistence using Electron safeStorage.
 * The raw token NEVER leaves the main process.
 */

import {
  requestRaw,
  requestV2,
  setTokenProvider,
  updateCsrfFromToken,
  clearCsrfToken,
} from "./wfmClient";
import { setStatusViaWebSocket } from "./wfmWebSocket";

const { app, safeStorage } = require("electron") as typeof import("electron");

const log = withScope("wfmSession");

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SessionSummary {
  loggedIn: boolean;
  userName: string | null;
  platform: string;
}

export interface SignInResult extends SessionSummary {
  loggedIn: true;
}

export interface SignOutResult {
  loggedIn: false;
}

export interface SetStatusResult {
  status: "online" | "ingame" | "invisible";
}

export interface WfmUserProfile {
  id: string;
  ingame_name: string;
  status: string;
  [key: string]: unknown;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_FILE = (): string => path.join(app.getPath("userData"), "wfm.session");
// ── In-memory state ───────────────────────────────────────────────────────────

let _token: string | null = null;
let _userName: string | null = null;
let _platform = "pc";

// Register the token provider so wfmClient can inject the JWT into requests
setTokenProvider(() => _token);

// ── Persistence helpers ───────────────────────────────────────────────────────

function _saveSession(token: string, userName: string): void {
  try {
    const payload = JSON.stringify({ token, userName, platform: _platform });
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(payload);
      fs.writeFileSync(SESSION_FILE(), encrypted);
      return;
    }

    log.warn("[WFMSession] safeStorage unavailable — session will not be persisted to disk");
  } catch (err) {
    log.error("[WFMSession] Failed to persist session:", normalizeErrorMessage(err));
  }
}

function _clearSession(): void {
  _token = null;
  _userName = null;
  clearCsrfToken();
  try {
    if (fs.existsSync(SESSION_FILE())) {
      fs.unlinkSync(SESSION_FILE());
    }
  } catch (err) {
    log.error("[WFMSession] Failed to clear session file:", normalizeErrorMessage(err));
  }
}

function _loadSession(): { token: string; userName: string; platform: string } | null {
  try {
    const file = SESSION_FILE();
    if (!fs.existsSync(file)) return null;

    const raw = fs.readFileSync(file);
    let payload: string;

    if (safeStorage.isEncryptionAvailable()) {
      payload = safeStorage.decryptString(raw);
    } else {
      log.warn("[WFMSession] safeStorage unavailable — skipping persisted session restore");
      return null;
    }

    return JSON.parse(payload);
  } catch (err) {
    log.error("[WFMSession] Failed to load session:", normalizeErrorMessage(err));
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sign in with email + password.
 * Returns a safe summary (no token) on success.
 * Throws on failure.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  if (!email || !password) {
    throw new Error("Email and password are required.");
  }

  const atIdx = (email || "").indexOf("@");
  log.log(
    "[WFMSession] signIn email shape — length:",
    email.length,
    "hasAt:",
    atIdx > 0,
    "localLen:",
    atIdx,
    "domainLen:",
    atIdx > 0 ? email.length - atIdx - 1 : 0,
    "isString:",
    typeof email === "string",
  );

  const { res, body } = await requestRaw("POST", "/auth/signin", {
    json: { email, password },
  });

  let token: string | null = null;

  const authHeader = res.headers.get("authorization");
  if (authHeader) {
    token = authHeader.toLowerCase().startsWith("jwt ")
      ? authHeader.slice(4).trim()
      : authHeader.trim();
  }

  if (!token) {
    const setCookie = res.headers.get("set-cookie") || "";
    const match = setCookie.match(/(?:^|,)\s*JWT=([^;,]+)/i);
    if (match) token = match[1].trim();
  }

  if (!token) {
    token = (body as any)?.payload?.token || (body as any)?.token || null;
  }

  if (!token) {
    throw new Error("Sign-in succeeded but no session token was returned. Please try again.");
  }

  const userInfo = (body as any)?.payload?.user || (body as any)?.user || {};
  const userName = userInfo.ingame_name || userInfo.name || email.split("@")[0];
  _platform = userInfo.platform || "pc";

  _token = token;
  _userName = userName;

  updateCsrfFromToken(token);

  _saveSession(token, userName);

  log.log(`[WFMSession] Signed in as: ${_userName}`);
  return { loggedIn: true, userName: _userName, platform: _platform };
}

/**
 * Sign out and remove persisted session.
 */
export function signOut(): SignOutResult {
  log.log("[WFMSession] Signing out");
  _clearSession();
  return { loggedIn: false };
}

/**
 * Restore session from disk (called on app startup).
 * Silently ignores missing/corrupt files.
 */
export async function restoreSession(): Promise<void> {
  const saved = _loadSession();
  if (!saved || !saved.token) {
    log.log("[WFMSession] No persisted session found.");
    return;
  }

  _token = saved.token;
  _userName = saved.userName || null;
  _platform = saved.platform || "pc";
  updateCsrfFromToken(saved.token);
  log.log(`[WFMSession] Restored session for: ${_userName}`);
}

/**
 * Return a safe session summary for the renderer.
 * Never includes the token.
 */
export function getSession(): SessionSummary {
  return {
    loggedIn: !!_token,
    userName: _userName || null,
    platform: _platform,
  };
}

/**
 * Returns the current JWT for main-process use only (e.g. WS listener).
 * Never expose this token to the renderer.
 */
export function getToken(): string | null {
  return _token;
}

/**
 * Return the in-game name (used by wfmOrders to build the profile URL).
 * Internal use only.
 */
export function getInGameName(): string | null {
  return _userName;
}

/**
 * Fetch current user profile from the v2 API.
 * Returns { id, ingame_name, status, ... } or null.
 */
export async function getMe(): Promise<WfmUserProfile | null> {
  if (!_token) return null;
  try {
    const data = await requestV2("GET", "/me") as any;
    return data?.data || null;
  } catch (err) {
    log.warn("[WFMSession] getMe failed:", normalizeErrorMessage(err));
    return null;
  }
}

/**
 * Set the authenticated user's online status via WebSocket.
 * @param status
 */
export async function setStatus(
  status: "online" | "ingame" | "invisible",
): Promise<SetStatusResult> {
  if (!_token) throw new Error("Not logged in to Warframe.market.");
  await setStatusViaWebSocket(_token, status);
  return { status };
}
