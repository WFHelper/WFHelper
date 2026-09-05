import { derived, get, readable, writable, type Readable } from "svelte/store";

import { readStoredJson, writeStorage } from "../lib/persistence.js";
import { isSafeMode } from "../lib/customCss/safeMode.js";
import {
  sanitizeCustomCss,
  verifyCustomCss,
  type SanitizedCustomCss,
} from "../lib/customCss/sanitize.js";

export const CUSTOM_CSS_STORAGE_KEY = "wf_custom_css_v1";

export interface CustomCssState {
  enabled: boolean;
  css: string;
  updatedAt: number;
}

const EMPTY: CustomCssState = { enabled: false, css: "", updatedAt: 0 };

function normalize(raw: unknown): CustomCssState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY;
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    css: typeof record.css === "string" ? record.css : "",
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : 0,
  };
}

function load(): CustomCssState {
  return readStoredJson(CUSTOM_CSS_STORAGE_KEY, normalize, () => EMPTY);
}

const store = writable<CustomCssState>(load());

function commit(next: CustomCssState): void {
  writeStorage(CUSTOM_CSS_STORAGE_KEY, JSON.stringify(next));
  store.set(next);
}

export const customCss = {
  subscribe: store.subscribe,
  /** Saves the editor draft. The stylesheet itself is only applied when enabled. */
  save(css: string): void {
    commit({ ...get(store), css: typeof css === "string" ? css : "", updatedAt: Date.now() });
  },
  setEnabled(enabled: boolean): void {
    commit({ ...get(store), enabled: enabled === true, updatedAt: Date.now() });
  },
  reset(): void {
    commit({ ...EMPTY, updatedAt: Date.now() });
  },
};

/** Constant for the lifetime of the load; the flag is decided before the first paint. */
export const safeMode: Readable<boolean> = readable(isSafeMode());

/**
 * Sanitized stylesheet for the current state. Safe mode and the opt-in toggle
 * both short-circuit to an empty sheet, so nothing user-authored can render.
 */
export function applyCustomCss(state: CustomCssState = get(store)): SanitizedCustomCss {
  if (isSafeMode() || !state.enabled) return { css: "", warnings: [] };
  const sanitized = sanitizeCustomCss(state.css);
  return {
    css: sanitized.css,
    warnings: [...sanitized.warnings, ...verifyCustomCss(sanitized.css)],
  };
}

export const activeCustomCss: Readable<string> = derived(
  store,
  (state) => applyCustomCss(state).css,
);
