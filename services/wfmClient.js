"use strict";

const log = require("./logger").withScope("wfmClient");
const { normalizeErrorMessage } = require("../config/shared/errors.cjs");

/**
 * wfmClient.js — Warframe.market HTTP client (main-process only)
 *
 * - Serial request queue with 350 ms minimum spacing (≤ 3 req/s)
 * - Standard headers required by WFM API
 * - Auth token injected automatically when a session is active
 * - Centralised error normalisation; 401 throws with err.code = 'WFM_UNAUTHORIZED'
 *
 * WFM CSRF protection uses a double-submit pattern:
 *   - The anonymous JWT from warframe.market/ is sent in both Cookie: and
 *     Authorization: headers on the sign-in POST.
 *   - For subsequent authenticated requests, Authorization: JWT <auth_token>
 *     alone satisfies the CSRF check (no X-CSRFToken header needed).
 */

const https = require("https");

const BASE_URL = "https://api.warframe.market/v1";
const BASE_URL_V2 = "https://api.warframe.market/v2";
const MIN_DELAY_MS = 350;
const REQUEST_TIMEOUT_MS = 20000;

// ── Rate-limit queue ──────────────────────────────────────────────────────────

let _queue = Promise.resolve();
let _lastRequestAt = 0;

/**
 * Enqueue a function that returns a promise, ensuring at least MIN_DELAY_MS
 * between consecutive requests.
 */
function enqueue(fn) {
  // Separate the result (can reject) from _queue (must always resolve).
  // Without this, a single failed request breaks all subsequent requests
  // because _queue becomes a permanently rejected promise.
  const result = _queue.then(async () => {
    const now = Date.now();
    const elapsed = now - _lastRequestAt;
    if (elapsed < MIN_DELAY_MS) {
      await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
    }
    _lastRequestAt = Date.now();
    return fn();
  });
  _queue = result.catch(() => {}); // keep queue alive after errors
  return result;
}

// ── CSRF token ────────────────────────────────────────────────────────────────

let _csrfToken = null;
let _cookieJwt = null; // raw JWT value to send as Cookie header

/**
 * WFM embeds the CSRF token inside the JWT cookie payload as `csrf_token`.
 * Decode a JWT string and return its payload, or null on failure.
 */
function _decodeJwtPayload(jwt) {
  try {
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * Fetch the anonymous JWT from warframe.market, decode its payload, and
 * extract the embedded `csrf_token`.  Caches the result.
 */
async function _ensureCsrfToken() {
  if (_csrfToken) return _csrfToken;
  try {
    // Use _nodeRequest so set-cookie headers aren't filtered
    const resp = await _nodeRequest(
      "GET",
      "https://warframe.market/",
      {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 WarframeCompanion/1.0",
      },
      null,
    );
    const sc = resp.headers.get("set-cookie") || "";
    const jwtMatch = sc.match(/\bJWT=([^;,\s]+)/i);
    if (jwtMatch) {
      _cookieJwt = jwtMatch[1];
      const payload = _decodeJwtPayload(_cookieJwt);
      if (payload?.csrf_token) {
        _csrfToken = payload.csrf_token;
        log.log("[WFMClient] CSRF token acquired from JWT payload");
      } else {
        log.warn("[WFMClient] JWT payload has no csrf_token:", JSON.stringify(payload));
      }
    } else {
      log.warn("[WFMClient] No JWT cookie in set-cookie:", sc.slice(0, 300));
    }
  } catch (e) {
    log.warn("[WFMClient] CSRF prefetch failed:", normalizeErrorMessage(e));
  }
  return _csrfToken;
}

/**
 * After a successful sign-in, call this with the authenticated JWT so that
 * subsequent mutation requests use the correct (authenticated) CSRF token.
 */
function updateCsrfFromToken(token) {
  const payload = _decodeJwtPayload(token);
  if (payload?.csrf_token) {
    _csrfToken = payload.csrf_token;
    _cookieJwt = token;
    log.log("[WFMClient] CSRF token updated from authenticated JWT");
  }
}

function clearCsrfToken() {
  _csrfToken = null;
  _cookieJwt = null;
}

// ── Low-level HTTPS helper (no forbidden-header filtering) ────────────────────

/**
 * Make a raw HTTPS request using Node.js https.request.
 * Returns a Response-like object: { ok, status, headers, json(), text() }
 */
function _nodeRequest(method, url, headers, body) {
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
    let timeoutId = null;

    function settleOk(value) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve(value);
    }

    function settleErr(err) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", settleErr);
      res.on("aborted", () => settleErr(new Error("WFM response aborted")));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        settleOk({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: {
            get: (name) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? v.join(", ") : (v ?? null);
            },
          },
          json: () => Promise.resolve(JSON.parse(text)),
          text: () => Promise.resolve(text),
        });
      });
    });

    timeoutId = setTimeout(() => {
      const err = new Error(`WFM request timeout after ${REQUEST_TIMEOUT_MS}ms`);
      err.code = "WFM_TIMEOUT";
      req.destroy(err);
    }, REQUEST_TIMEOUT_MS);

    req.on("error", settleErr);
    if (body) {
      // Set Content-Length so the request uses fixed-length framing
      // instead of Transfer-Encoding: chunked (some servers reject chunked)
      const buf = Buffer.from(body, "utf-8");
      req.setHeader("Content-Length", buf.length);
      req.write(buf);
    }
    req.end();
  });
}

// ── Token accessor (injected by wfmSession) ───────────────────────────────────

let _getToken = () => null;

/**
 * Called once by wfmSession to register a token provider function.
 * This avoids circular requires.
 */
function setTokenProvider(fn) {
  _getToken = fn;
}

// ── Core request ──────────────────────────────────────────────────────────────

/**
 * Shared request logic for both v1 and v2 WFM API endpoints.
 * Handles auth, CSRF, rate limiting, and error normalisation.
 *
 * @param {string} baseUrl      API base (v1 or v2)
 * @param {"GET"|"POST"|"PUT"|"DELETE"} method
 * @param {string} path         e.g. "/profile/orders"
 * @param {object} [opts]
 * @param {object} [opts.json]         Request body
 * @param {object} [opts.headers]      Extra headers merged in
 * @param {object} [opts.baseHeaders]  Base headers (differs between v1/v2)
 * @param {string} [opts.label]        Label for log messages
 * @returns {Promise<object>}          Parsed JSON response body
 */
function _coreRequest(
  baseUrl,
  method,
  path,
  { json, headers: extraHeaders, baseHeaders = {}, label = "WFMClient" } = {},
) {
  return enqueue(async () => {
    const token = _getToken();
    const url = baseUrl + path;

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Platform: "pc",
      Language: "en",
      ...baseHeaders,
      ...extraHeaders,
    };

    if (token) {
      headers["Authorization"] = `JWT ${token}`;
      headers["Cookie"] = `JWT=${token}`;
    }

    if (method !== "GET") {
      await _ensureCsrfToken();
      const jwtForCookie = token || _cookieJwt;
      if (jwtForCookie && !headers["Cookie"]) headers["Cookie"] = `JWT=${jwtForCookie}`;
      headers["Origin"] = "https://warframe.market";
      headers["Referer"] = "https://warframe.market/";
    }

    const body = json !== undefined ? JSON.stringify(json) : null;

    let res;
    try {
      res = await _nodeRequest(method, url, headers, body);
    } catch (networkErr) {
      const err = new Error(`${label} network error: ${normalizeErrorMessage(networkErr)}`);
      err.code = "WFM_NETWORK_ERROR";
      throw err;
    }

    if (res.status === 401) {
      const err = new Error("Warframe.market session expired or invalid.");
      err.code = "WFM_UNAUTHORIZED";
      err.status = 401;
      throw err;
    }

    if (res.status === 429) {
      const retryAfterSec = parseInt(res.headers.get("retry-after") || "30", 10);
      const cooldownMs = Math.max(retryAfterSec * 1000, 30_000);
      _lastRequestAt = Date.now() + cooldownMs - MIN_DELAY_MS;
      log.warn(`[${label}] Rate limited (429). Cooling down for ${Math.ceil(cooldownMs / 1000)}s.`);
      const err = new Error(
        `Warframe.market rate limit hit. Please wait ${Math.ceil(cooldownMs / 1_000)}s.`,
      );
      err.code = "WFM_RATE_LIMITED";
      err.status = 429;
      throw err;
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        log.log(`[${label}] ${method} ${path} → ${res.status} body:`, text.slice(0, 500));
        try {
          const rb = JSON.parse(text);
          if (rb?.error?.message) detail = rb.error.message;
          else if (typeof rb?.error === "string") detail = rb.error;
          else if (rb?.message) detail = rb.message;
        } catch (_) {}
      } catch (parseErr) {
        log.warn(`[${label}] Failed to read error response body:`, normalizeErrorMessage(parseErr));
      }
      const err = new Error(`${label} API error: ${detail}`);
      err.code = "WFM_API_ERROR";
      err.status = res.status;
      throw err;
    }

    if (res.status === 204) return null;
    return res.json();
  });
}

function request(method, path, opts = {}) {
  return _coreRequest(BASE_URL, method, path, { ...opts, label: "WFMClient" });
}

function requestV2(method, path, opts = {}) {
  return _coreRequest(BASE_URL_V2, method, path, {
    ...opts,
    baseHeaders: { Crossplay: "true" },
    label: "WFMClient v2",
  });
}

/**
 * Same as request() but also returns the raw Response (for header extraction).
 * Used by wfmSession.signIn() to extract the JWT from the Authorization header.
 */
function requestRaw(method, path, { json, headers: extraHeaders } = {}) {
  return enqueue(async () => {
    const url = BASE_URL + path;

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Platform: "pc",
      Language: "en",
      ...extraHeaders,
    };

    // Attach CSRF headers for sign-in POST.
    // WFM uses double-submit: same anonymous JWT must appear in both
    // Cookie: and Authorization: headers to pass CSRF validation.
    if (method !== "GET") {
      await _ensureCsrfToken(); // ensures _cookieJwt is populated
      if (_cookieJwt) {
        headers["Cookie"] = `JWT=${_cookieJwt}`;
        headers["Authorization"] = `JWT ${_cookieJwt}`;
      }
      headers["Origin"] = "https://warframe.market";
      headers["Referer"] = "https://warframe.market/";
    }

    const body = json !== undefined ? JSON.stringify(json) : null;

    let res;
    try {
      res = await _nodeRequest(method, url, headers, body);
    } catch (networkErr) {
      const err = new Error(`WFM network error: ${normalizeErrorMessage(networkErr)}`);
      err.code = "WFM_NETWORK_ERROR";
      throw err;
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      let rawBody = null;
      try {
        rawBody = await res.json();
        if (typeof rawBody?.error === "string") {
          detail = rawBody.error;
        } else if (typeof rawBody?.error?.message === "string") {
          detail = rawBody.error.message;
        } else if (rawBody?.message) {
          detail = rawBody.message;
        } else if (rawBody?.error && typeof rawBody.error === "object") {
          const msgs = Object.values(rawBody.error).flat().slice(0, 2);
          detail = msgs.length ? msgs.join("; ") : "Invalid credentials.";
        }
      } catch (_) {
        /* ignore parse error */
      }
      log.error(`[WFMClient] sign-in ${res.status} body:`, JSON.stringify(rawBody));
      const err = new Error(`WFM sign-in error: ${detail}`);
      err.code = res.status === 401 ? "WFM_UNAUTHORIZED" : "WFM_API_ERROR";
      err.status = res.status;
      throw err;
    }

    const resBody = await res.json();
    return { res, body: resBody };
  });
}

module.exports = {
  request,
  requestV2,
  requestRaw,
  setTokenProvider,
  clearCsrfToken,
  updateCsrfFromToken,
};
