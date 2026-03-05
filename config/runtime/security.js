"use strict";

const OPEN_EXTERNAL_ALLOWED_HOSTS = Object.freeze([
  "warframe.market",
  "www.warframe.market",
  "github.com",
  "www.github.com",
  "sainan.github.io",
]);

const BASE_CONNECT_SRC_ALLOWLIST = Object.freeze([
  "'self'",
  "https://api.warframe.market",
  "https://warframe.market",
  "https://content.warframe.com",
  "https://api.warframestat.us",
  "http://localhost:*",
  "https://localhost:*",
]);

function toAllowedConnectOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildConnectSrcAllowlist() {
  const entries = new Set(BASE_CONNECT_SRC_ALLOWLIST);

  const backendOrigin = toAllowedConnectOrigin(process.env.VITE_WFM_BACKEND_URL || "");
  if (backendOrigin) {
    entries.add(backendOrigin);
  }

  const extraRaw = String(process.env.WF_CONNECT_SRC_EXTRA || "").trim();
  if (extraRaw) {
    for (const entry of extraRaw.split(",")) {
      const origin = toAllowedConnectOrigin(entry);
      if (origin) entries.add(origin);
    }
  }

  return [...entries].join(" ");
}

function isAllowedExternalHost(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!host) return false;
  return OPEN_EXTERNAL_ALLOWED_HOSTS.includes(host);
}

const MAIN_WINDOW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  `connect-src ${buildConnectSrcAllowlist()}`,
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

module.exports = {
  OPEN_EXTERNAL_ALLOWED_HOSTS,
  BASE_CONNECT_SRC_ALLOWLIST,
  isAllowedExternalHost,
  toAllowedConnectOrigin,
  buildConnectSrcAllowlist,
  MAIN_WINDOW_CSP,
};
