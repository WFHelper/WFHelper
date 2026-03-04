"use strict";

const OPEN_EXTERNAL_ALLOWED_HOSTS = Object.freeze([
  "warframe.market",
  "www.warframe.market",
  "github.com",
  "www.github.com",
  "sainan.github.io",
]);

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
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https:",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

module.exports = {
  OPEN_EXTERNAL_ALLOWED_HOSTS,
  isAllowedExternalHost,
  MAIN_WINDOW_CSP,
};
