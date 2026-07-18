import "./app.css";
import App from "./App.svelte";
import { send } from "./lib/ipc.js";
import { themeSettings } from "./stores/theme.js";
import type { ThemeColors } from "./types/theme.js";
import { THEME_COLOR_CSS_MAP } from "./types/theme.js";
import {
  OVERLAY_FORWARDED_FONT_VARS,
  OVERLAY_FORWARDED_EFFECT_VARS,
} from "../config/shared/themeCssVars.js";

if (!window.api) {
  console.error(
    "[Renderer] FATAL: window.api is undefined. The preload bridge failed to initialize.\n" +
      "This usually means preload.js threw an error during startup.\n" +
      "Check the main process terminal output for errors.",
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root mount node");
}

const DEFAULT_ACCENT_GLOW = "rgba(212, 168, 67, 0.15)";

/** Convert a `#rrggbb` accent colour to a translucent glow, or fall back. */
function accentGlow(accent: string): string {
  if (!accent.startsWith("#")) return DEFAULT_ACCENT_GLOW;
  const clean = accent.slice(1);
  if (clean.length !== 6) return DEFAULT_ACCENT_GLOW;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return DEFAULT_ACCENT_GLOW;
  return `rgba(${r}, ${g}, ${b}, 0.15)`;
}

themeSettings.subscribe((settings) => {
  if (typeof window.api?.updateOverlayTheme !== "function") {
    return;
  }

  const colors = settings?.colors;
  if (!colors) return;

  const vars: Record<string, string> = {};
  for (const [key, cssVar] of Object.entries(THEME_COLOR_CSS_MAP) as Array<
    [keyof ThemeColors, string]
  >) {
    const value = colors[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    vars[cssVar] = value;
  }

  if (vars["--accent"]) {
    vars["--accent-glow"] = accentGlow(vars["--accent"]);
  }

  const rootStyle = window.document?.documentElement
    ? window.document.documentElement.style
    : null;

  const copyRootVar = (name: string): void => {
    if (!rootStyle) return;
    const value = rootStyle.getPropertyValue(name);
    if (!value || value.trim().length === 0) return;
    vars[name] = value.trim();
  };

  for (const cssVar of OVERLAY_FORWARDED_FONT_VARS) {
    copyRootVar(cssVar);
  }
  for (const cssVar of OVERLAY_FORWARDED_EFFECT_VARS) {
    copyRootVar(cssVar);
  }

  send("overlay-theme-updated", vars);
});

const app = new App({ target: root });

export default app;
