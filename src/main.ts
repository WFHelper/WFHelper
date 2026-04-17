import "./app.css";
import App from "./App.svelte";
import { initRendererCrashReporting } from "./lib/crashReporting.js";
import { send } from "./lib/ipc.js";
import { themeSettings } from "./stores/theme.js";

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

initRendererCrashReporting();

const OVERLAY_THEME_KEYS = Object.freeze([
  "bgDeep",
  "bgBase",
  "bgSurface",
  "bgRaised",
  "bgHover",
  "accent",
  "accentDim",
  "accentBright",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "success",
  "warning",
  "danger",
  "info",
  "border",
  "borderStrong",
] as const);

const OVERLAY_THEME_VAR_MAP: Record<(typeof OVERLAY_THEME_KEYS)[number], string> = {
  bgDeep: "--bg-deep",
  bgBase: "--bg-base",
  bgSurface: "--bg-surface",
  bgRaised: "--bg-raised",
  bgHover: "--bg-hover",
  accent: "--accent",
  accentDim: "--accent-dim",
  accentBright: "--accent-bright",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  info: "--info",
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

  const rootStyle =
    typeof window !== "undefined" && window.document?.documentElement
      ? window.document.documentElement.style
      : null;

  const copyRootVar = (name: string): void => {
    if (!rootStyle) return;
    const value = rootStyle.getPropertyValue(name);
    if (!value || value.trim().length === 0) return;
    vars[name] = value.trim();
  };

  copyRootVar("--font-display");
  copyRootVar("--font-body");
  copyRootVar("--font-heading-size");
  copyRootVar("--font-body-size");
  copyRootVar("--font-small-size");

  send("overlay-theme-updated", vars);
});

const app = new App({ target: root });

export default app;
