import https from "node:https";
import { withScope } from "./logger";
import {
  rateLimitError,
  scheduleWfmRequest,
  WfmApiError,
  type WfmAttemptOutcome,
  type WfmRequestPriority,
} from "./wfmScheduler";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("wfmClient");

// Prefer header auth and retain the cookie plus CSRF fallback. Pacing,
// concurrency and backoff all live in wfmScheduler.

export { WfmApiError };

interface WfmRequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
  /** requestRaw only: send header-style auth and skip the CSRF machinery. */
  headerAuth?: boolean;
  priority?: WfmRequestPriority;
}

interface WfmResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface WfmRawResponse {
  res: WfmResponseLike;
  body: unknown;
}

const BASE_URL = "https://api.warframe.market/v1";
const BASE_URL_V2 = "https://api.warframe.market/v2";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Applied when a 429 carries no Retry-After of its own. */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;

// Keep auth and CSRF at call sites because core and raw requests use different tokens.
const WFM_BASE_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Platform: "pc",
  Language: "en",
};

/** Only GET/HEAD may be replayed: a 5xx or a dropped socket on a mutation can
 *  still have been applied server-side, so a retry could double-create. */
function _isReplayable(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** Everything that reached the transport but failed there. Timeouts and
 *  oversize bodies arrive here too, already wrapped as WFM_NETWORK_ERROR. */
function _transportFailure<T>(err: unknown, retryable: boolean): WfmAttemptOutcome<T> {
  const isTransport = err instanceof WfmApiError && err.code === "WFM_NETWORK_ERROR";
  return {
    kind: "failure",
    error: err as Error,
    retryable: retryable && isTransport,
    transient: isTransport,
  };
}

let _csrfToken: string | null = null;
let _cookieJwt: string | null = null;

function _decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

function _extractCsrfMeta(html: string): string | null {
  const nameFirst = html.match(
    /<meta\b(?=[^>]*\bname=["']csrf-token["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/i,
  );
  if (nameFirst?.[1]) return nameFirst[1];

  const contentFirst = html.match(
    /<meta\b(?=[^>]*\bcontent=["']([^"']+)["'])(?=[^>]*\bname=["']csrf-token["'])[^>]*>/i,
  );
  return contentFirst?.[1] ?? null;
}

// We ARE a Chromium runtime - identify as one when the plain UA gets scored.
function _browserUa(): string {
  const os = process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome ?? "136.0.0.0"} Safari/537.36`;
}

type CsrfAttemptResult = "ok" | "challenge" | "no-token";

async function _csrfAttempt(userAgent: string): Promise<CsrfAttemptResult> {
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": userAgent,
  };
  if (_cookieJwt) headers["Cookie"] = `JWT=${_cookieJwt}`;

  const resp = await _request("GET", "https://warframe.market/", headers, null);
  const html = await resp.text();
  const sc = resp.headers.get("set-cookie") || "";
  const jwtMatch = sc.match(/\bJWT=([^;,\s]+)/i);
  const metaCsrf = _extractCsrfMeta(html);
  if (jwtMatch) _cookieJwt = jwtMatch[1];
  const payload = _cookieJwt ? _decodeJwtPayload(_cookieJwt) : null;
  if (typeof payload?.csrf_token === "string" && payload.csrf_token) {
    _csrfToken = payload.csrf_token;
    log.info("[WFMClient] CSRF token acquired from JWT payload");
    return "ok";
  }
  if (metaCsrf && !metaCsrf.startsWith("##")) {
    _csrfToken = metaCsrf;
    log.info("[WFMClient] CSRF token acquired from page meta");
    return "ok";
  }
  // No cookie AND no meta = we did not get the real WFM page (usually a
  // Cloudflare challenge or a local proxy) - fingerprint it for reports.
  const title = (html.match(/<title>([^<]{0,60})/i)?.[1] || "").trim();
  log.warn(
    `[WFMClient] No usable csrf token (jwt cookie: ${jwtMatch ? "yes" : "no"}, ` +
      `meta: ${metaCsrf ? metaCsrf.slice(0, 12) + "..." : "none"}, ` +
      `status=${resp.status}, bytes=${html.length}, title="${title}")`,
  );
  const isChallenge =
    resp.headers.get("cf-mitigated") === "challenge" ||
    (resp.status === 403 && /just a moment|cf-chl|challenge-platform/i.test(html));
  return isChallenge ? "challenge" : "no-token";
}

// Cloudflare clearance earned by a real window solving the JS challenge.
// The clearance is bound to the UA it was earned with - send the same one.
let _clearanceCookie: string | null = null;
let _clearanceUa: string | null = null;
let _challengeSolve: Promise<boolean> | null = null;

function _solveChallengeInWindow(): Promise<boolean> {
  if (_challengeSolve) return _challengeSolve;
  _challengeSolve = (async () => {
    try {
      const { BrowserWindow, session } = require("electron") as typeof import("electron");
      const part = session.fromPartition("persist:wfm-clearance");
      // Keep Chromium's native UA because Turnstile detects mismatched client hints.
      const win = new BrowserWindow({
        width: 480,
        height: 640,
        show: false,
        title: "warframe.market security check",
        autoHideMenuBar: true,
        webPreferences: {
          partition: "persist:wfm-clearance",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e, target) => {
        if (!/^https:\/\/([a-z0-9-]+\.)?warframe\.market\//i.test(target)) e.preventDefault();
      });
      try {
        void win.loadURL("https://warframe.market/");
        const startedAt = Date.now();
        let shown = false;
        let lastCookieLog = 0;
        while (Date.now() - startedAt < 120_000) {
          await new Promise((r) => setTimeout(r, 500));
          if (win.isDestroyed()) return false; // user closed the window
          const cookies = await part.cookies.get({ domain: ".warframe.market" });
          const jwt = cookies.find((c) => c.name === "JWT")?.value;
          const now = Date.now();
          if (!jwt && now - lastCookieLog > 4_000) {
            lastCookieLog = now;
            log.info(
              `[WFMClient] challenge pending, cookies: [${cookies.map((c) => c.name).join(", ")}]`,
            );
          }
          if (jwt) {
            const cf = cookies.filter((c) => /^(cf_clearance|__cf)/i.test(c.name));
            _clearanceCookie = cf.length ? cf.map((c) => `${c.name}=${c.value}`).join("; ") : null;
            // Bind to the UA that actually earned clearance - cf_clearance is
            // rejected if replayed under a different UA.
            _clearanceUa = win.webContents.getUserAgent();
            _cookieJwt = jwt;
            log.info(
              `[WFMClient] challenge window passed after ${now - startedAt}ms ` +
                `(${cf.length ? "clearance stored" : "no clearance cookie"}, shown: ${shown})`,
            );
            return true;
          }
          // Managed challenges self-solve in a few seconds; interactive ones
          // (turnstile checkbox) need the user - surface the window.
          if (!shown && now - startedAt > 8_000) {
            shown = true;
            win.show();
            log.info("[WFMClient] challenge needs interaction - showing window");
          }
        }
        log.warn("[WFMClient] challenge window timed out");
        return false;
      } finally {
        if (!win.isDestroyed()) win.destroy();
      }
    } catch (e) {
      log.warn("[WFMClient] challenge window failed:", normalizeErrorMessage(e));
      return false;
    } finally {
      _challengeSolve = null;
    }
  })();
  return _challengeSolve;
}

let _challengeSolver: () => Promise<boolean> = _solveChallengeInWindow;

// Retry one expired clearance per cooldown to avoid challenge loops.
const CLEARANCE_RESOLVE_COOLDOWN_MS = 5 * 60_000;
let _lastClearanceSolveAt = 0;

async function _shouldReSolveClearance(res: WfmResponseLike): Promise<boolean> {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  if (res.status !== 403) return false;
  if (_clearanceCookie) return true; // stale clearance is the likely cause
  const text = await res.text().catch(() => "");
  return /just a moment|cf-chl|challenge-platform/i.test(text);
}

async function _reSolveClearance(label: string): Promise<boolean> {
  const now = Date.now();
  if (now - _lastClearanceSolveAt < CLEARANCE_RESOLVE_COOLDOWN_MS) return false;
  _lastClearanceSolveAt = now;
  log.warn(
    `[${label}] Cloudflare block with ${_clearanceCookie ? "stale" : "no"} clearance - re-running challenge`,
  );
  _clearanceCookie = null;
  _clearanceUa = null;
  if (!(await _challengeSolver())) return false;
  const payload = _cookieJwt ? _decodeJwtPayload(_cookieJwt) : null;
  if (typeof payload?.csrf_token === "string" && payload.csrf_token)
    _csrfToken = payload.csrf_token;
  return true;
}

let _csrfFetch: Promise<string | null> | null = null;

// Single-flight: concurrent mutations would otherwise each run the page
// prefetch (and each open its own challenge window).
function _ensureCsrfToken(): Promise<string | null> {
  if (_csrfToken) return Promise.resolve(_csrfToken);
  if (_csrfFetch) return _csrfFetch;
  _csrfFetch = _fetchCsrfToken().finally(() => {
    _csrfFetch = null;
  });
  return _csrfFetch;
}

async function _fetchCsrfToken(): Promise<string | null> {
  try {
    // Browser UA first: it matches the chromium transport's TLS fingerprint,
    // and a mismatched pair is itself a bot signal.
    const first = await _csrfAttempt(_browserUa());
    if (first === "ok") return _csrfToken;
    if (first === "no-token" && (await _csrfAttempt("Mozilla/5.0 WFHelper/1.0")) === "ok") {
      return _csrfToken;
    }
    // Challenged (or persistently tokenless): only a real page can run the
    // challenge JS - solve it in a window and reuse the earned cookies.
    if (await _solveChallengeInWindow()) {
      const payload = _cookieJwt ? _decodeJwtPayload(_cookieJwt) : null;
      if (typeof payload?.csrf_token === "string" && payload.csrf_token) {
        _csrfToken = payload.csrf_token;
        log.info("[WFMClient] CSRF token acquired via challenge window");
      }
    }
  } catch (e) {
    log.warn("[WFMClient] CSRF prefetch failed:", normalizeErrorMessage(e));
  }
  return _csrfToken;
}

export function updateCsrfFromToken(token: string): void {
  _cookieJwt = token;
  const payload = _decodeJwtPayload(token);
  // Always overwrite: a cached token from a previous (anonymous) JWT no longer
  // matches the cookie we will send from now on.
  if (typeof payload?.csrf_token === "string" && payload.csrf_token) {
    _csrfToken = payload.csrf_token;
    log.info("[WFMClient] CSRF token updated from JWT payload");
  }
}

export function clearCsrfToken(): void {
  _csrfToken = null;
  _cookieJwt = null;
}

function _makeResponse(
  status: number,
  rawHeaders: Record<string, string | string[] | undefined>,
  text: string,
): WfmResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        const v = rawHeaders[name.toLowerCase()];
        return Array.isArray(v) ? v.join(", ") : (v ?? null);
      },
    },
    json: () => {
      try {
        return Promise.resolve(JSON.parse(text));
      } catch (err) {
        // Upstream returned non-JSON (HTML error page, empty proxy body, etc) -
        // surface a typed error callers can pattern-match, not a raw SyntaxError.
        return Promise.reject(
          new WfmApiError(
            `WFM returned non-JSON response (status ${status}): ${(err as Error).message} - preview: ${text.slice(0, 200)}`,
            "WFM_INVALID_JSON",
            status,
          ),
        );
      }
    },
    text: () => Promise.resolve(text),
  };
}

// Prefer Electron's Chromium net stack: it carries a real browser TLS
// fingerprint, which WFM's bot filtering 403s node TLS for on flagged IPs.
let _transportLogged = false;
// Chromium's stack fails outright on setups node https survives (broken
// system proxy, AV interception) - after one proven failure, stay on node.
let _nodeTransportLatched = false;
let _chromiumNetOverride: typeof import("electron").net | null | undefined;

function _chromiumNet(): typeof import("electron").net | null {
  if (_chromiumNetOverride !== undefined) return _chromiumNetOverride;
  try {
    const electron = require("electron") as typeof import("electron");
    if (electron?.net && electron.app?.isReady()) return electron.net;
  } catch {
    // plain node (tests, scripts) - no electron runtime
  }
  return null;
}

async function _request(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<WfmResponseLike> {
  const net = _nodeTransportLatched ? null : _chromiumNet();
  if (!_transportLogged) {
    _transportLogged = true;
    log.info(`[WFMClient] transport: ${net ? "chromium" : "node"}`);
  }
  // Prevent retries from retaining stale auth.
  headers = { ...headers };
  // Ride the earned clearance: the cookie only passes with the UA it was
  // earned under, so both travel together on every request.
  if (_clearanceUa) headers["User-Agent"] = _clearanceUa;
  if (_clearanceCookie) {
    headers["Cookie"] = headers["Cookie"]
      ? `${headers["Cookie"]}; ${_clearanceCookie}`
      : _clearanceCookie;
  }
  if (!net) return _nodeRequest(method, url, headers, body);
  try {
    return await _chromiumRequest(net, method, url, headers, body);
  } catch (err) {
    const message = normalizeErrorMessage(err);
    if (!/net::ERR_/.test(message)) throw err;
    log.warn(`[WFMClient] chromium transport failed (${message}) - retrying via node https`);
    const res = await _nodeRequest(method, url, headers, body);
    _nodeTransportLatched = true;
    log.warn("[WFMClient] node transport latched for this session");
    return res;
  }
}

function _chromiumRequest(
  net: typeof import("electron").net,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<WfmResponseLike> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    function settleOk(value: WfmResponseLike) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve(value);
    }

    function settleErr(err: Error) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    }

    const req = net.request({ method, url, redirect: "manual" });
    for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);

    // Node's https never follows redirects - synthesize the 3xx for parity.
    req.on("redirect", (statusCode, _redirMethod, _redirectUrl, responseHeaders) => {
      settleOk(_makeResponse(statusCode, responseHeaders, ""));
      req.abort();
    });

    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      res.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          settleErr(new WfmApiError("WFM response exceeded 8 MiB", "WFM_RESPONSE_TOO_LARGE"));
          req.abort();
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", (err: Error) => settleErr(err));
      res.on("end", () => {
        settleOk(
          _makeResponse(res.statusCode ?? 0, res.headers, Buffer.concat(chunks).toString("utf-8")),
        );
      });
    });

    req.on("error", settleErr);
    timeoutId = setTimeout(() => {
      settleErr(
        new WfmApiError(`WFM request timeout after ${REQUEST_TIMEOUT_MS}ms`, "WFM_TIMEOUT"),
      );
      req.abort();
    }, REQUEST_TIMEOUT_MS);

    if (body) req.write(Buffer.from(body, "utf-8"));
    req.end();
  });
}

function _nodeRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<WfmResponseLike> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
    };

    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    function settleOk(value: WfmResponseLike) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve(value);
    }

    function settleErr(err: Error) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    }

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      res.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          const error = new WfmApiError("WFM response exceeded 8 MiB", "WFM_RESPONSE_TOO_LARGE");
          settleErr(error);
          res.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", settleErr);
      res.on("aborted", () => settleErr(new Error("WFM response aborted")));
      res.on("end", () => {
        settleOk(
          _makeResponse(res.statusCode ?? 0, res.headers, Buffer.concat(chunks).toString("utf-8")),
        );
      });
    });

    timeoutId = setTimeout(() => {
      const err = new WfmApiError(
        `WFM request timeout after ${REQUEST_TIMEOUT_MS}ms`,
        "WFM_TIMEOUT",
      );
      req.destroy(err);
    }, REQUEST_TIMEOUT_MS);

    req.on("error", settleErr);
    if (body) {
      const buf = Buffer.from(body, "utf-8");
      req.setHeader("Content-Length", buf.length);
      req.write(buf);
    }
    req.end();
  });
}

let _getToken: () => string | null = () => null;

export function setTokenProvider(fn: () => string | null): void {
  _getToken = fn;
}

// Latched only when a header-auth 401/403 succeeds via the cookie fallback -
// proof the rejection was about the auth style, not the token.
let _headerAuthBroken = false;
let _tokenRotationHandler: ((token: string) => void) | null = null;

export function setTokenRotationHandler(fn: ((token: string) => void) | null): void {
  _tokenRotationHandler = fn;
}

// WFM rotates session tokens via the response Authorization header.
function _noteRotatedToken(res: WfmResponseLike): void {
  if (!_tokenRotationHandler) return;
  const header = res.headers.get("authorization");
  if (!header) return;
  const token = header.replace(/^(?:Bearer|JWT)\s+/i, "").trim();
  if (token && token !== _getToken()) _tokenRotationHandler(token);
}

interface CoreRequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
  baseHeaders?: Record<string, string>;
  label?: string;
  priority?: WfmRequestPriority;
}

function flattenErrorMessages(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (depth > 4 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenErrorMessages(entry, depth + 1)).slice(0, 4);
  }
  // Object: recurse, prefixing a bare leaf with its field name (e.g.
  // {inputs:{perTrade:"app.field.required"}} -> "perTrade: app.field.required").
  const out: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    for (const msg of flattenErrorMessages(entry, depth + 1)) {
      out.push(/[:\s]/.test(msg) ? msg : `${key}: ${msg}`);
    }
  }
  return out.slice(0, 4);
}

export function extractWfmErrorDetail(body: unknown, objectErrorFallback?: string): string | null {
  if (!body || typeof body !== "object") return null;

  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  if (error && typeof error === "object") {
    const messages = flattenErrorMessages(error);
    if (messages.length > 0) return messages.join("; ");
    return objectErrorFallback ?? null;
  }
  return null;
}

/** A 429 is always replayable - the request was rejected, never applied - so
 *  even a mutation may retry once the stated wait is short enough. Credential
 *  posts opt out: resending a password is never worth a retry. */
function rateLimitFailure<T>(
  label: string,
  res: WfmResponseLike,
  retryable = true,
): WfmAttemptOutcome<T> {
  const retryAfterSec = parseInt(res.headers.get("retry-after") || "", 10);
  const cooldownMs = Number.isFinite(retryAfterSec)
    ? Math.max(retryAfterSec * 1000, 1_000)
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  log.warn(`[${label}] Rate limited (429). Cooling down for ${Math.ceil(cooldownMs / 1000)}s.`);
  return {
    kind: "failure",
    status: 429,
    retryAfterMs: cooldownMs,
    retryable,
    transient: true,
    error: rateLimitError(cooldownMs),
  };
}

/** The prefetch fetches a page of its own and can open a challenge window that
 *  waits on the user, so it gives the request slot back while it runs. A token
 *  already in hand needs neither. */
function _csrfTokenOutsideSlot(ctx: WfmAttemptContext | undefined): Promise<string | null> {
  if (_csrfToken || !ctx) return _ensureCsrfToken();
  return ctx.runUnadmitted(_ensureCsrfToken);
}

async function applyMutationHeaders(
  headers: Record<string, string>,
  jwtForCookie: string | null,
  jwtForAuthorization: string | null | undefined = undefined,
  ctx?: WfmAttemptContext,
): Promise<void> {
  let cookieJwt = jwtForCookie ?? _cookieJwt;
  if (!cookieJwt) {
    await _csrfTokenOutsideSlot(ctx); // the page prefetch also captures the anonymous JWT
    cookieJwt = _cookieJwt;
  }
  // Double-submit: the header must carry the csrf_token claim of the SAME JWT
  // we present as the cookie - a token cached from another JWT mismatches.
  const claim = cookieJwt ? _decodeJwtPayload(cookieJwt)?.csrf_token : undefined;
  const csrfToken = typeof claim === "string" && claim ? claim : await _csrfTokenOutsideSlot(ctx);
  const authorizationJwt = jwtForAuthorization === undefined ? cookieJwt : jwtForAuthorization;
  if (csrfToken && !headers["X-CSRFToken"]) headers["X-CSRFToken"] = csrfToken;
  if (cookieJwt && !headers["Cookie"]) headers["Cookie"] = `JWT=${cookieJwt}`;
  if (authorizationJwt) headers["Authorization"] = `JWT ${authorizationJwt}`;
  headers["Origin"] = "https://warframe.market";
  headers["Referer"] = "https://warframe.market/";
}

function _coreRequest(
  baseUrl: string,
  method: string,
  path: string,
  {
    json,
    headers: extraHeaders,
    baseHeaders = {},
    label = "WFMClient",
    priority,
  }: CoreRequestOptions = {},
): Promise<unknown> {
  const url = baseUrl + path;
  const body = json !== undefined ? JSON.stringify(json) : null;
  const authScheme = baseUrl === BASE_URL_V2 ? "Bearer" : "JWT";
  const replayable = _isReplayable(method);

  return scheduleWfmRequest<unknown>(
    async (_attemptNumber, ctx): Promise<WfmAttemptOutcome<unknown>> => {
      // Rebuild auth headers after clearance recovery.
      const attempt = async (useHeaderAuth: boolean): Promise<WfmResponseLike> => {
        const token = _getToken();
        const headers: Record<string, string> = {
          ...WFM_BASE_HEADERS,
          ...baseHeaders,
          ...extraHeaders,
        };

        if (token && useHeaderAuth) {
          headers["Authorization"] = `${authScheme} ${token}`;
          headers["auth_type"] = "header";
        } else if (token) {
          headers["Authorization"] = `JWT ${token}`;
          headers["Cookie"] = `JWT=${token}`;
        }

        if (method !== "GET" && !(token && useHeaderAuth)) {
          await applyMutationHeaders(headers, token || _cookieJwt, null, ctx);
        }

        try {
          return await _request(method, url, headers, body);
        } catch (networkErr) {
          throw new WfmApiError(
            `${label} network error: ${normalizeErrorMessage(networkErr)}`,
            "WFM_NETWORK_ERROR",
          );
        }
      };

      const headerAuth = (): boolean => !_headerAuthBroken && !!_getToken();

      let res: WfmResponseLike;
      try {
        res = await attempt(headerAuth());
        if (headerAuth() && (res.status === 401 || res.status === 403)) {
          const fallback = await attempt(false);
          if (fallback.ok) {
            _headerAuthBroken = true;
            log.warn(
              `[${label}] header auth rejected (${res.status}) but cookie+csrf works - latched`,
            );
          }
          res = fallback;
        }
        if (!res.ok && (await _shouldReSolveClearance(res))) {
          // The challenge window can sit open for as long as the user takes.
          if (await ctx.runUnadmitted(() => _reSolveClearance(label))) {
            res = await attempt(headerAuth());
          }
        }
      } catch (err) {
        return _transportFailure(err, replayable);
      }
      if (res.ok) _noteRotatedToken(res);

      if (res.status === 401) {
        return {
          kind: "failure",
          status: 401,
          retryable: false,
          transient: false,
          error: new WfmApiError(
            "Warframe.market session expired or invalid.",
            "WFM_UNAUTHORIZED",
            401,
          ),
        };
      }

      if (res.status === 429) return rateLimitFailure(label, res);

      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        // A redirect carries no body, so its target is the only thing that says why.
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (location) detail = `HTTP ${res.status} -> ${location}`;
        try {
          const text = await res.text();
          log.info(`[${label}] ${method} ${path} -> ${res.status} body:`, text.slice(0, 500));
          try {
            const parsed = JSON.parse(text) as unknown;
            detail = extractWfmErrorDetail(parsed) ?? detail;
          } catch {
            // ignore - detail already has a fallback value
          }
        } catch (parseErr) {
          log.warn(
            `[${label}] Failed to read error response body:`,
            normalizeErrorMessage(parseErr),
          );
        }
        const serverFault = res.status >= 500;
        const error = new WfmApiError(`${label} API error: ${detail}`, "WFM_API_ERROR", res.status);
        if (location) {
          // Resolved against the request URL so a bare path keeps WFM's origin.
          try {
            error.location = new URL(location, url).href;
          } catch {
            // An unparsable Location is reported through the message only.
          }
        }
        return {
          kind: "failure",
          status: res.status,
          retryable: serverFault && replayable,
          transient: serverFault,
          error,
        };
      }

      if (res.status === 204) return { kind: "ok", value: null };
      return { kind: "ok", value: await res.json() };
    },
    { label, priority },
  );
}

export function request(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  opts: WfmRequestOptions = {},
): Promise<unknown> {
  return _coreRequest(BASE_URL, method, path, { ...opts, label: "WFMClient" });
}

/** Where WFM redirects `path`, or null when it serves the path directly. A
 *  redirect is never re-sent with the original method or body, so a caller that
 *  has to POST must resolve the target first. Probed with HEAD; only a target on
 *  the API's own v1 root is trusted. */
export function requestRedirectTarget(
  path: string,
  priority?: WfmRequestPriority,
): Promise<string | null> {
  const url = BASE_URL + path;
  return scheduleWfmRequest<string | null>(
    async (): Promise<WfmAttemptOutcome<string | null>> => {
      let res: WfmResponseLike;
      try {
        res = await _request("HEAD", url, { ...WFM_BASE_HEADERS }, null);
      } catch (err) {
        return {
          kind: "failure",
          error: err as Error,
          retryable: true,
          transient: true,
        };
      }
      if (res.status < 300 || res.status >= 400) return { kind: "ok", value: null };
      const location = res.headers.get("location");
      if (!location) return { kind: "ok", value: null };
      // Location is as often a bare path as a full URL. Resolving against the
      // probed URL is what gives "//host/x" its real origin, so the root check
      // has to run on the resolved target and never on the raw header.
      let target: URL | null;
      try {
        target = new URL(location, url);
      } catch {
        target = null;
      }
      if (!target || !target.href.startsWith(`${BASE_URL}/`)) {
        log.warn(`[WFMClient] redirect target off the v1 root for ${path}: ${location}`);
        return { kind: "ok", value: null };
      }
      return { kind: "ok", value: target.href };
    },
    { label: "WFMClient", priority },
  ).catch((err: unknown) => {
    // A full queue is caller-visible backpressure, not a failed probe.
    if (err instanceof WfmApiError && err.code === "WFM_QUEUE_FULL") throw err;
    log.warn(`[WFMClient] redirect probe failed for ${path}:`, normalizeErrorMessage(err));
    return null;
  });
}

export function requestV2(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  opts: WfmRequestOptions = {},
): Promise<unknown> {
  return _coreRequest(BASE_URL_V2, method, path, {
    ...opts,
    baseHeaders: { Crossplay: "true" },
    label: "WFMClient v2",
  });
}

export function requestRaw(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  { json, headers: extraHeaders, headerAuth = false, priority }: WfmRequestOptions = {},
): Promise<WfmRawResponse> {
  const url = BASE_URL + path;
  const body = json !== undefined ? JSON.stringify(json) : null;
  const replayable = _isReplayable(method);

  return scheduleWfmRequest<WfmRawResponse>(
    async (_attemptNumber, ctx): Promise<WfmAttemptOutcome<WfmRawResponse>> => {
      const attempt = async (): Promise<WfmResponseLike> => {
        const headers: Record<string, string> = {
          ...WFM_BASE_HEADERS,
          ...extraHeaders,
        };

        if (headerAuth) {
          // Anonymous header-mode call (sign-in): the bare scheme opts out of
          // the cookie session, so no CSRF page fetch is needed.
          headers["Authorization"] = "JWT";
          headers["auth_type"] = "header";
        } else if (method !== "GET") {
          await applyMutationHeaders(headers, null, undefined, ctx);
        }

        try {
          return await _request(method, url, headers, body);
        } catch (networkErr) {
          throw new WfmApiError(
            `WFM network error: ${normalizeErrorMessage(networkErr)}`,
            "WFM_NETWORK_ERROR",
          );
        }
      };

      let res: WfmResponseLike;
      try {
        res = await attempt();
        if (!res.ok && (await _shouldReSolveClearance(res))) {
          if (await ctx.runUnadmitted(() => _reSolveClearance("WFMClient"))) res = await attempt();
        }
      } catch (err) {
        return _transportFailure(err, replayable);
      }

      // Sign-in carries the user's password; the scheduler must never resend
      // it on its own, and wfmSession fast-fails a surfaced 429 by design.
      if (res.status === 429) return rateLimitFailure("WFMClient", res, false);

      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const rawBody = await res.json();
          detail = extractWfmErrorDetail(rawBody, "Invalid credentials.") ?? detail;
        } catch {
          /* ignore parse error */
        }
        log.error(`[WFMClient] sign-in failed: status=${res.status}, detail=${detail}`);
        const serverFault = res.status >= 500;
        return {
          kind: "failure",
          status: res.status,
          retryable: serverFault && replayable,
          transient: serverFault,
          error: new WfmApiError(
            `WFM sign-in error: ${detail}`,
            res.status === 401 ? "WFM_UNAUTHORIZED" : "WFM_API_ERROR",
            res.status,
          ),
        };
      }

      const resBody = await res.json();
      return { kind: "ok", value: { res, body: resBody } };
    },
    { label: "WFMClient", priority },
  );
}

export const __test__ = {
  resetHeaderAuthForTest(): void {
    _headerAuthBroken = false;
  },
  setClearanceForTest(cookie: string | null, ua: string | null): void {
    _clearanceCookie = cookie;
    _clearanceUa = ua;
  },
  setChromiumNetForTest(net: typeof import("electron").net | null | undefined): void {
    _chromiumNetOverride = net;
    _nodeTransportLatched = false;
  },
  setChallengeSolverForTest(fn: (() => Promise<boolean>) | null): void {
    _challengeSolver = fn ?? _solveChallengeInWindow;
  },
  resetClearanceCooldownForTest(): void {
    _lastClearanceSolveAt = 0;
  },
};
