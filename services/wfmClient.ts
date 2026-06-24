import https from "node:https";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("wfmClient");

/**
 * Warframe.market HTTP client (main-process only)
 *
 * - Serial request queue with 350 ms minimum spacing (≤ 3 req/s)
 * - Standard headers required by WFM API
 * - Auth token injected automatically when a session is active
 * - Centralised error normalisation; 401 throws with err.code = 'WFM_UNAUTHORIZED'
 *
 * WFM CSRF protection uses a double-submit pattern:
 *   - The anonymous JWT from warframe.market/ is sent in both Cookie: and
 *     Authorization: headers on the sign-in POST.
 *   - Mutating requests also send the page <meta name="csrf-token"> value as
 *     X-CSRFToken.
 */

interface WfmRequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
}

export class WfmApiError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "WfmApiError";
    this.code = code;
    this.status = status;
  }
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
const MIN_DELAY_MS = 350;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_QUEUE_DEPTH = 64;

// Shared by both _coreRequest and requestRaw. The auth (Authorization/Cookie)
// and CSRF (Origin/Referer) headers are NOT here because the two callers have
// different auth models - _coreRequest uses the user JWT via _getToken(),
// requestRaw uses _cookieJwt. Keep those at the call sites where the
// difference is visible.
const WFM_BASE_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Platform: "pc",
  Language: "en",
};

let _queue: Promise<void> = Promise.resolve();
let _lastRequestAt = 0;
let _queueDepth = 0;

/**
 * Enqueue a function that returns a promise, ensuring at least MIN_DELAY_MS
 * between consecutive requests. Rejects synchronously when the pending-request
 * backlog exceeds MAX_QUEUE_DEPTH - prevents unbounded growth during WFM outages.
 */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (_queueDepth >= MAX_QUEUE_DEPTH) {
    return Promise.reject(
      new WfmApiError(
        `WFM request queue full (${_queueDepth}/${MAX_QUEUE_DEPTH}) - backend likely unavailable.`,
        "WFM_QUEUE_FULL",
      ),
    );
  }
  _queueDepth++;
  const result = _queue.then(async () => {
    const now = Date.now();
    const elapsed = now - _lastRequestAt;
    if (elapsed < MIN_DELAY_MS) {
      await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
    }
    _lastRequestAt = Date.now();
    return fn();
  });
  const decrement = () => {
    _queueDepth--;
  };
  result.then(decrement, decrement);
  _queue = result.catch(() => {}) as Promise<void>;
  return result;
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

async function _ensureCsrfToken(): Promise<string | null> {
  if (_csrfToken) return _csrfToken;
  try {
    const headers: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 WarframeCompanion/1.0",
    };
    if (_cookieJwt) headers["Cookie"] = `JWT=${_cookieJwt}`;

    const resp = await _nodeRequest(
      "GET",
      "https://warframe.market/",
      headers,
      null,
    );
    const html = await resp.text();
    const sc = resp.headers.get("set-cookie") || "";
    const jwtMatch = sc.match(/\bJWT=([^;,\s]+)/i);
    const metaCsrf = _extractCsrfMeta(html);
    if (jwtMatch) {
      _cookieJwt = jwtMatch[1];
      const payload = _decodeJwtPayload(_cookieJwt);
      if (typeof metaCsrf === "string" && metaCsrf) {
        _csrfToken = metaCsrf;
        log.info("[WFMClient] CSRF token acquired from page meta");
      } else if (typeof payload?.csrf_token === "string") {
        _csrfToken = payload.csrf_token;
        log.info("[WFMClient] CSRF token acquired from JWT payload fallback");
      } else {
        log.warn("[WFMClient] Page and JWT payload have no csrf token");
      }
    } else {
      log.warn("[WFMClient] No JWT cookie in set-cookie:", sc.slice(0, 300));
    }
  } catch (e) {
    log.warn("[WFMClient] CSRF prefetch failed:", normalizeErrorMessage(e));
  }
  return _csrfToken;
}

export function updateCsrfFromToken(token: string): void {
  _cookieJwt = token;
  const payload = _decodeJwtPayload(token);
  if (!_csrfToken && typeof payload?.csrf_token === "string") {
    _csrfToken = payload.csrf_token;
    log.info("[WFMClient] CSRF token updated from authenticated JWT fallback");
  }
}

export function clearCsrfToken(): void {
  _csrfToken = null;
  _cookieJwt = null;
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
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", settleErr);
      res.on("aborted", () => settleErr(new Error("WFM response aborted")));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        settleOk({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          headers: {
            get: (name: string) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? v.join(", ") : (v ?? null);
            },
          },
          json: () => {
            try {
              return Promise.resolve(JSON.parse(text));
            } catch (err) {
              // Upstream returned non-JSON (HTML error page, empty body from a
              // proxy, etc). Convert to a typed WfmApiError so callers get a
              // rejected promise they can pattern-match, instead of a raw
              // SyntaxError surfacing unpredictably higher up the stack.
              const preview = text.slice(0, 200);
              return Promise.reject(
                new WfmApiError(
                  `WFM returned non-JSON response (status ${res.statusCode ?? 0}): ${(err as Error).message} - preview: ${preview}`,
                  "WFM_INVALID_JSON",
                  res.statusCode ?? 0,
                ),
              );
            }
          },
          text: () => Promise.resolve(text),
        });
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

interface CoreRequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
  baseHeaders?: Record<string, string>;
  label?: string;
}

function flattenErrorMessages(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (depth > 4 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenErrorMessages(entry, depth + 1)).slice(0, 4);
  }
  // Object: recurse, prefixing a bare leaf with its field name (e.g.
  // {inputs:{perTrade:"app.field.required"}} → "perTrade: app.field.required").
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

function throwRateLimitError(label: string, res: WfmResponseLike): never {
  const retryAfterSec = parseInt(res.headers.get("retry-after") || "30", 10);
  const cooldownMs = Math.max(retryAfterSec * 1000, 30_000);
  _lastRequestAt = Date.now() + cooldownMs - MIN_DELAY_MS;
  log.warn(`[${label}] Rate limited (429). Cooling down for ${Math.ceil(cooldownMs / 1000)}s.`);
  throw new WfmApiError(
    `Warframe.market rate limit hit. Please wait ${Math.ceil(cooldownMs / 1_000)}s before trying again.`,
    "WFM_RATE_LIMITED",
    429,
  );
}

async function applyMutationHeaders(
  headers: Record<string, string>,
  jwtForCookie: string | null,
  jwtForAuthorization: string | null | undefined = undefined,
): Promise<void> {
  const csrfToken = await _ensureCsrfToken();
  const cookieJwt = jwtForCookie ?? _cookieJwt;
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
  { json, headers: extraHeaders, baseHeaders = {}, label = "WFMClient" }: CoreRequestOptions = {},
): Promise<unknown> {
  return enqueue(async () => {
    const token = _getToken();
    const url = baseUrl + path;

    const headers: Record<string, string> = {
      ...WFM_BASE_HEADERS,
      ...baseHeaders,
      ...extraHeaders,
    };

    if (token) {
      headers["Authorization"] = `JWT ${token}`;
      headers["Cookie"] = `JWT=${token}`;
    }

    if (method !== "GET") {
      await applyMutationHeaders(headers, token || _cookieJwt, null);
    }

    const body = json !== undefined ? JSON.stringify(json) : null;

    let res: WfmResponseLike;
    try {
      res = await _nodeRequest(method, url, headers, body);
    } catch (networkErr) {
      throw new WfmApiError(
        `${label} network error: ${normalizeErrorMessage(networkErr)}`,
        "WFM_NETWORK_ERROR",
      );
    }

    if (res.status === 401) {
      throw new WfmApiError("Warframe.market session expired or invalid.", "WFM_UNAUTHORIZED", 401);
    }

    if (res.status === 429) throwRateLimitError(label, res);

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        log.info(`[${label}] ${method} ${path} → ${res.status} body:`, text.slice(0, 500));
        try {
          const parsed = JSON.parse(text) as unknown;
          detail = extractWfmErrorDetail(parsed) ?? detail;
        } catch {
          // ignore - detail already has a fallback value
        }
      } catch (parseErr) {
        log.warn(`[${label}] Failed to read error response body:`, normalizeErrorMessage(parseErr));
      }
      const err = new WfmApiError(`${label} API error: ${detail}`, "WFM_API_ERROR", res.status);
      throw err;
    }

    if (res.status === 204) return null;
    return res.json();
  });
}

export function request(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  opts: WfmRequestOptions = {},
): Promise<unknown> {
  return _coreRequest(BASE_URL, method, path, { ...opts, label: "WFMClient" });
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
  { json, headers: extraHeaders }: WfmRequestOptions = {},
): Promise<WfmRawResponse> {
  return enqueue(async () => {
    const url = BASE_URL + path;

    const headers: Record<string, string> = {
      ...WFM_BASE_HEADERS,
      ...extraHeaders,
    };

    if (method !== "GET") {
      await applyMutationHeaders(headers, null);
    }

    const body = json !== undefined ? JSON.stringify(json) : null;

    let res: WfmResponseLike;
    try {
      res = await _nodeRequest(method, url, headers, body);
    } catch (networkErr) {
      throw new WfmApiError(
        `WFM network error: ${normalizeErrorMessage(networkErr)}`,
        "WFM_NETWORK_ERROR",
      );
    }

    if (res.status === 429) throwRateLimitError("WFMClient", res);

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const rawBody = await res.json();
        detail = extractWfmErrorDetail(rawBody, "Invalid credentials.") ?? detail;
      } catch {
        /* ignore parse error */
      }
      log.error(`[WFMClient] sign-in failed: status=${res.status}, detail=${detail}`);
      throw new WfmApiError(
        `WFM sign-in error: ${detail}`,
        res.status === 401 ? "WFM_UNAUTHORIZED" : "WFM_API_ERROR",
        res.status,
      );
    }

    const resBody = await res.json();
    return { res, body: resBody };
  });
}
