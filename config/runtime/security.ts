import { BACKEND_URL } from "../shared/backendConfig";

const OPEN_EXTERNAL_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  "warframe.market",
  "www.warframe.market",
  "github.com",
  "www.github.com",
  "sainan.github.io",
  "wiki.warframe.com",
]);

const BASE_CONNECT_SRC_ALLOWLIST: readonly string[] = Object.freeze([
  "'self'",
  "https://api.warframe.market",
  "https://warframe.market",
  "https://content.warframe.com",
  "https://api.warframestat.us",
  "https://drops.warframestat.us",
]);

export function toAllowedConnectOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const isLocalhost = parsed.hostname === "localhost";
    if (isLocalhost && parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLocalhost && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildConnectSrcAllowlist(): string {
  const entries = new Set<string>(BASE_CONNECT_SRC_ALLOWLIST);

  // Allow localhost connections only during development
  try {
    const { app } = require("electron") as typeof import("electron");
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
    backendUrl = BACKEND_URL || "";
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

export function isAllowedExternalHost(hostname: unknown): boolean {
  const host = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!host) return false;
  return OPEN_EXTERNAL_ALLOWED_HOSTS.includes(host);
}

export const MAIN_WINDOW_CSP = [
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

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), usb=()";

