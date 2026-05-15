import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import type { WfmStatus } from "../config/shared/wfm";

import {
  requestRaw,
  requestV2,
  setTokenProvider,
  updateCsrfFromToken,
  clearCsrfToken,
} from "./wfmClient";
import { setStatusViaWebSocket } from "./wfmWebSocket";
import { app, safeStorage } from "electron";

const log = withScope("wfmSession");


interface SessionSummary {
  loggedIn: boolean;
  userName: string | null;
  platform: string;
}

interface SignInResult extends SessionSummary {
  loggedIn: true;
}

interface SignOutResult {
  loggedIn: false;
}

interface SetStatusResult {
  status: WfmStatus;
}

interface WfmUserProfile {
  id: string;
  ingame_name: string;
  status: string;
  [key: string]: unknown;
}


const SESSION_FILE = (): string => path.join(app.getPath("userData"), "wfm.session");
const DEVICE_ID_FILE = (): string => path.join(app.getPath("userData"), "wfm.device-id");

let _token: string | null = null;
let _userName: string | null = null;
let _platform = "pc";

// Register the token provider so wfmClient can inject the JWT into requests
setTokenProvider(() => _token);


function _getDeviceId(): string {
  try {
    const file = DEVICE_ID_FILE();
    if (fs.existsSync(file)) {
      const saved = fs.readFileSync(file, "utf-8").trim();
      if (saved) return saved;
    }

    const id = randomUUID();
    fs.writeFileSync(file, id, "utf-8");
    return id;
  } catch (err) {
    log.warn("[WFMSession] Failed to persist device id:", normalizeErrorMessage(err));
    return "warframe-companion";
  }
}

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

function _authField<T>(body: unknown, key: string): T | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped WFM auth envelope
  const b = body as any;
  return b?.payload?.[key] ?? b?.[key] ?? undefined;
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  if (!email || !password) {
    throw new Error("Email and password are required.");
  }

  const atIdx = (email || "").indexOf("@");
  log.log(
    "[WFMSession] signIn email shape - length:",
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
    json: { email, password, device_id: _getDeviceId() },
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
    token = _authField<string>(body, "token") || null;
  }

  if (!token) {
    throw new Error("Sign-in succeeded but no session token was returned. Please try again.");
  }

  const userInfo = _authField<Record<string, string>>(body, "user") || {};
  const userName = userInfo.ingame_name || userInfo.name || email.split("@")[0];
  _platform = userInfo.platform || "pc";

  _token = token;
  _userName = userName;

  updateCsrfFromToken(token);

  _saveSession(token, userName);

  log.log(`[WFMSession] Signed in as: ${_userName}`);
  return { loggedIn: true, userName: _userName, platform: _platform };
}

export function signOut(): SignOutResult {
  log.log("[WFMSession] Signing out");
  _clearSession();
  return { loggedIn: false };
}

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

export function getSession(): SessionSummary {
  return {
    loggedIn: !!_token,
    userName: _userName || null,
    platform: _platform,
  };
}

export function getToken(): string | null {
  return _token;
}

export function getInGameName(): string | null {
  return _userName;
}

export async function getMe(): Promise<WfmUserProfile | null> {
  if (!_token) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped WFM v2 envelope
    const data = (await requestV2("GET", "/me")) as Record<string, any>;
    return (data?.data ?? null) as WfmUserProfile | null;
  } catch (err) {
    log.warn("[WFMSession] getMe failed:", normalizeErrorMessage(err));
    return null;
  }
}

export async function setStatus(
  status: WfmStatus,
): Promise<SetStatusResult> {
  if (!_token) throw new Error("Not logged in to Warframe.market.");
  await setStatusViaWebSocket(_token, status);
  return { status };
}
