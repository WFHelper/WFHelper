import fs from "fs";
import { randomUUID } from "crypto";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import { normalizeErrorMessage } from "../config/shared/errors";
import { normalizeWfmSlug, sanitizeWfmSlug, type WfmStatus } from "../config/shared/wfm";

import {
  requestRaw,
  requestV2,
  setTokenProvider,
  setTokenRotationHandler,
  updateCsrfFromToken,
  clearCsrfToken,
} from "./wfmClient";
import { WfmApiError } from "./wfmTypes";
import { setStatusViaWebSocket } from "./wfmWebSocket";
import { safeStorage } from "electron";

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
  /** ISO timestamp WFM will expire the status at; null when it is held indefinitely. */
  statusUntil: string | null;
}

interface WfmUserProfile {
  id: string;
  ingame_name: string;
  status: string;
  [key: string]: unknown;
}

const SESSION_FILE = (): string => userDataPath("wfm.session");
const DEVICE_ID_FILE = (): string => userDataPath("wfm.device-id");

let _token: string | null = null;
let _userName: string | null = null;
let _platform = "pc";
let _profileSlug: string | null = null;
let _profileSlugProbe: Promise<string | null> | null = null;

// Register the token provider so wfmClient can inject the JWT into requests
setTokenProvider(() => _token);

// WFM rotates the session token via response Authorization headers - adopt
// and persist the rotation so long sessions never expire mid-flight.
setTokenRotationHandler((token) => {
  if (!_token || token === _token) return;
  _token = token;
  updateCsrfFromToken(token);
  if (_userName) _saveSession(token, _userName);
  log.info("[WFMSession] Session token rotated by WFM");
});

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
    return "wfhelper";
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

    log.warn("[WFMSession] safeStorage unavailable - session will not be persisted to disk");
  } catch (err) {
    log.error("[WFMSession] Failed to persist session:", normalizeErrorMessage(err));
  }
}

function _resetProfileSlug(): void {
  _profileSlug = null;
  _profileSlugProbe = null;
}

function _clearSession(): void {
  _token = null;
  _userName = null;
  _resetProfileSlug();
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
      log.warn("[WFMSession] safeStorage unavailable - skipping persisted session restore");
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

  // Do not retry credential errors through legacy auth; the auth style is not the cause.
  let raw: Awaited<ReturnType<typeof requestRaw>>;
  try {
    raw = await requestRaw("POST", "/auth/signin", {
      json: { email, password, device_id: _getDeviceId(), auth_type: "header" },
      headerAuth: true,
    });
  } catch (err) {
    const status = err instanceof WfmApiError ? err.status : undefined;
    const detail = err instanceof Error ? err.message : "";
    if (status === 401 || status === 429 || detail.includes("app.account.")) throw err;
    log.warn(
      "[WFMSession] header sign-in failed - falling back to csrf sign-in:",
      normalizeErrorMessage(err),
    );
    raw = await requestRaw("POST", "/auth/signin", {
      json: { email, password, device_id: _getDeviceId() },
    });
  }
  const { res, body } = raw;

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
  _resetProfileSlug();

  updateCsrfFromToken(token);

  _saveSession(token, userName);

  log.info(`[WFMSession] Signed in as: ${_userName}`);
  return { loggedIn: true, userName: _userName, platform: _platform };
}

export function signOut(): SignOutResult {
  log.info("[WFMSession] Signing out");
  _clearSession();
  return { loggedIn: false };
}

export async function restoreSession(): Promise<void> {
  const saved = _loadSession();
  if (!saved || !saved.token) {
    log.info("[WFMSession] No persisted session found.");
    return;
  }

  _token = saved.token;
  _userName = saved.userName || null;
  _platform = saved.platform || "pc";
  _resetProfileSlug();
  updateCsrfFromToken(saved.token);
  log.info(`[WFMSession] Restored session for: ${_userName}`);
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

// Throws on transport failure so callers can tell "WFM did not answer" from
// "WFM answered without the field"; getMe() below folds both into null.
async function _requestMe(): Promise<WfmUserProfile | null> {
  if (!_token) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped WFM v2 envelope
  const data = (await requestV2("GET", "/me")) as Record<string, any>;
  return (data?.data ?? null) as WfmUserProfile | null;
}

/** The account's own profile slug, which every self-addressed WFM route needs.
 *  `/v2/me` mints it, so it is authoritative; it is read once per session and
 *  cached, and folding the name is only the fallback for an absent answer. */
export async function getProfileSlug(): Promise<string | null> {
  const name = _userName;
  if (!name) return null;
  if (_profileSlug) return _profileSlug;

  const folded = normalizeWfmSlug(name);
  let probe = _profileSlugProbe;
  if (!probe) {
    // Free the slot only while it still holds this probe: a sign-out mid-flight
    // clears it, and the next account may already have started its own.
    const settle = (): void => {
      if (_profileSlugProbe === probe) _profileSlugProbe = null;
    };
    probe = _requestMe().then(
      (me) => {
        settle();
        // WFM minted this, so the catalog allowlist is the gate that fits: it
        // keeps path separators out of every self-addressed route below.
        const slug = sanitizeWfmSlug(me?.slug);
        // Same reason: a late answer must not seed another account's slug.
        if (_userName === name) _profileSlug = slug ?? folded;
        return slug;
      },
      (err) => {
        settle();
        throw err;
      },
    );
    _profileSlugProbe = probe;
  }

  try {
    return (await probe) ?? folded;
  } catch (err) {
    // A transport failure is not an answer, so the next call may ask again.
    log.warn("[WFMSession] Profile slug lookup failed:", normalizeErrorMessage(err));
    return folded;
  }
}

export async function getMe(): Promise<WfmUserProfile | null> {
  try {
    return await _requestMe();
  } catch (err) {
    log.warn("[WFMSession] getMe failed:", normalizeErrorMessage(err));
    return null;
  }
}

export async function setStatus(
  status: WfmStatus,
  durationSeconds: number | null = null,
): Promise<SetStatusResult> {
  if (!_token) throw new Error("Not logged in to Warframe.market.");
  const { statusUntil } = await setStatusViaWebSocket(_token, status, durationSeconds);
  return { status, statusUntil };
}

/** Our presence as everyone else sees it. `/v2/me` omits status, the public
 * profile carries it - and WFM reports a hidden user as "offline". */
export async function getPublicStatus(): Promise<WfmStatus | null> {
  if (!_token || !_userName) return null;
  try {
    const slug = await getProfileSlug();
    if (!slug) return null;
    // Only the one field is read, so the envelope needs no type of its own.
    const data = (await requestV2("GET", `/user/${encodeURIComponent(slug)}`)) as {
      data?: { status?: unknown };
    };
    const status = String(data?.data?.status ?? "").toLowerCase();
    if (status === "online" || status === "ingame" || status === "invisible") return status;
    return status === "offline" ? "invisible" : null;
  } catch (err) {
    log.warn("[WFMSession] getPublicStatus failed:", normalizeErrorMessage(err));
    return null;
  }
}
