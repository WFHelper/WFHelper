/**
 * Default backend Worker URL. The main process reads this directly; the
 * renderer overrides it via `VITE_WFM_BACKEND_URL` (Vite `import.meta.env`).
 */
export const BACKEND_URL = "https://api.wfhelper.com";
