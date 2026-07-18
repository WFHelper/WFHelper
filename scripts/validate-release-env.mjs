#!/usr/bin/env node

const errors = [];

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) errors.push(`Missing required release variable: ${name}`);
  return value;
}

function requireHttpsUrl(name) {
  const value = required(name);
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") errors.push(`${name} must use HTTPS`);
  } catch {
    errors.push(`${name} must be a valid URL`);
  }
}

requireHttpsUrl("VITE_WFM_BACKEND_URL");

const fallback = required("VITE_WFM_BACKEND_DIRECT_FALLBACK");
if (fallback && !new Set(["always", "high", "never"]).has(fallback)) {
  errors.push("VITE_WFM_BACKEND_DIRECT_FALLBACK must be always, high, or never");
}

const bootstrap = required("VITE_WFM_BACKEND_BOOTSTRAP_ENABLED");
if (bootstrap && bootstrap !== "1") {
  errors.push("VITE_WFM_BACKEND_BOOTSTRAP_ENABLED must be 1 for production releases");
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("Release runtime configuration is complete.");
