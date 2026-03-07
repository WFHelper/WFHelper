import "./app.css";
import App from "./App.svelte";
import { initRendererCrashReporting } from "./lib/crashReporting.js";
import { ipc } from "./lib/ipc.js";
import { themeSettings } from "./stores/theme.js";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root mount node");
}

initRendererCrashReporting();

const OVERLAY_THEME_KEYS = Object.freeze([
  "bgDeep",
  "bgBase",
  "bgSurface",
  "bgRaised",
  "accent",
  "accentDim",
  "accentBright",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "border",
  "borderStrong",
] as const);

const OVERLAY_THEME_VAR_MAP: Record<(typeof OVERLAY_THEME_KEYS)[number], string> = {
  bgDeep: "--bg-deep",
  bgBase: "--bg-base",
  bgSurface: "--bg-surface",
  bgRaised: "--bg-raised",
  accent: "--accent",
  accentDim: "--accent-dim",
  accentBright: "--accent-bright",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  border: "--border",
  borderStrong: "--border-strong",
};

themeSettings.subscribe((settings) => {
  if (typeof window === "undefined" || typeof window.api?.updateOverlayTheme !== "function") {
    return;
  }

  const colors = settings?.colors;
  if (!colors) return;

  const vars: Record<string, string> = {};
  for (const key of OVERLAY_THEME_KEYS) {
    const value = colors[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    vars[OVERLAY_THEME_VAR_MAP[key]] = value;
  }

  if (vars["--accent"]) {
    vars["--accent-glow"] = vars["--accent"].startsWith("#")
      ? (() => {
          const clean = vars["--accent"].slice(1);
          if (clean.length !== 6) return "rgba(212, 168, 67, 0.15)";
          const r = Number.parseInt(clean.slice(0, 2), 16);
          const g = Number.parseInt(clean.slice(2, 4), 16);
          const b = Number.parseInt(clean.slice(4, 6), 16);
          if (![r, g, b].every(Number.isFinite)) return "rgba(212, 168, 67, 0.15)";
          return `rgba(${r}, ${g}, ${b}, 0.15)`;
        })()
      : "rgba(212, 168, 67, 0.15)";
  }

  ipc.send("overlay-theme-updated", vars);
});

const app = new App({ target: root });

export default app;
