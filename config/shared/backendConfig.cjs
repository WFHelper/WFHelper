"use strict";

/**
 * Single source of truth for the backend-lite Worker URL.
 *
 * Used by:
 *   - config/runtime/security.js  → CSP connect-src allowlist (main process)
 *   - .env.local / .env           → VITE_WFM_BACKEND_URL (renderer, via Vite)
 *
 * The renderer gets the URL from Vite's import.meta.env at build time.
 * The main process reads this file directly since it doesn't use Vite.
 *
 * Set VITE_WFM_BACKEND_URL in the environment to override at runtime.
 */
module.exports = {
  BACKEND_URL: "https://worker.wfcompanion-cache.workers.dev",
};
