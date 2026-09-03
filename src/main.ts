import "./app.css";
import App from "./App.svelte";
import { send } from "./lib/ipc.js";
import { accentGlowColor } from "./lib/theme/applyTheme.js";
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
    vars["--accent-glow"] = accentGlowColor(vars["--accent"]);
  }

  const rootStyle = window.document?.documentElement ? window.document.documentElement.style : null;

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
