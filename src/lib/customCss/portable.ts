import { byteLength, CUSTOM_CSS_MAX_BYTES, type CustomCssWarningReason } from "./sanitize.js";

/** Envelope written by Export, so a future combined preset can carry more fields. */
interface CustomCssExport {
  version: 1;
  css: string;
  enabled: boolean;
  updatedAt: number;
}

type CustomCssImport =
  | { ok: true; css: string; enabled: boolean | null }
  | { ok: false; reason: CustomCssWarningReason };

export function exportCustomCss(state: {
  css: string;
  enabled: boolean;
  updatedAt: number;
}): string {
  const payload: CustomCssExport = {
    version: 1,
    css: typeof state.css === "string" ? state.css : "",
    enabled: state.enabled === true,
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : 0,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Accepts either an export envelope or a plain .css file. The caller still runs
 * the sanitizer; this only guards the container (type and size).
 */
export function importCustomCss(text: unknown): CustomCssImport {
  if (typeof text !== "string") return { ok: false, reason: "notText" };
  if (byteLength(text) > CUSTOM_CSS_MAX_BYTES) return { ok: false, reason: "tooLarge" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const envelope = parsed as Record<string, unknown>;
    if (typeof envelope.css !== "string") return { ok: false, reason: "notText" };
    if (byteLength(envelope.css) > CUSTOM_CSS_MAX_BYTES) return { ok: false, reason: "tooLarge" };
    return {
      ok: true,
      css: envelope.css,
      enabled: typeof envelope.enabled === "boolean" ? envelope.enabled : null,
    };
  }

  return { ok: true, css: text, enabled: null };
}
