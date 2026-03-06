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

  // Allow localhost connections only during development
  try {
    const { app } = require("electron");
    if (!app.isPackaged) {
      entries.add("http://localhost:*");
      entries.add("https://localhost:*");
    }
  } catch {
    // If electron isn't available (e.g. tests), skip localhost entries
  }

  // Backend-lite Worker URL: use env override or shared config.
  // The renderer gets this via Vite's import.meta.env, but the main process
  // doesn't use Vite, so we read the shared config directly.
  let backendUrl = process.env.VITE_WFM_BACKEND_URL || "";
  if (!backendUrl) {
    try {
      const { BACKEND_URL } = require("../shared/backendConfig.cjs");
      backendUrl = BACKEND_URL || "";
    } catch {
      // shared config missing — skip
    }
  }
  const backendOrigin = toAllowedConnectOrigin(backendUrl);
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

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), usb=()";

module.exports = {
  OPEN_EXTERNAL_ALLOWED_HOSTS,
  BASE_CONNECT_SRC_ALLOWLIST,
  isAllowedExternalHost,
  toAllowedConnectOrigin,
  buildConnectSrcAllowlist,
  MAIN_WINDOW_CSP,
  PERMISSIONS_POLICY,
};
