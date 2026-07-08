import type { BrowserWindow } from "electron";
import type { FSWatcher } from "chokidar";
import { withScope } from "../services/logger";
import type { OverlaySettings } from "../config/runtime/overlaySettings";
import { OVERLAY_SETTINGS_DEFAULTS } from "../config/runtime/overlaySettings";

type InventoryData = Record<string, unknown> | null;
type OverlayThemeVars = Record<string, string>;

interface MainProcessContext {
  mainWindow: BrowserWindow | null;
  overlayWindow: BrowserWindow | null;
  plannerOverlayWindow: BrowserWindow | null;
  rivenOverlayLeftWindow: BrowserWindow | null;
  rivenOverlayRightWindow: BrowserWindow | null;
  tradeNotificationWindow: BrowserWindow | null;
  arbiSummaryWindow: BrowserWindow | null;
  currentInventoryPath: string | null;
  currentInventoryData: InventoryData;
  watcher: FSWatcher | null;
  overlaySettings: OverlaySettings;
  overlayThemeVars: OverlayThemeVars;
  overlayHotkeyRegistered: string | null;
  overlayInteractionHotkeyRegistered: string | null;
  overlayInteractiveMode: boolean;
  overlayDismissedUntilMs: number;
}

type ContextKey = keyof MainProcessContext;
type PresenceKey =
  | "mainWindow"
  | "overlayWindow"
  | "plannerOverlayWindow"
  | "rivenOverlayLeftWindow"
  | "rivenOverlayRightWindow"
  | "tradeNotificationWindow"
  | "arbiSummaryWindow"
  | "currentInventoryPath"
  | "watcher";
type QuotedKey = "overlayHotkeyRegistered" | "overlayInteractionHotkeyRegistered";

const log = withScope("ctx");
const presenceKeys: ReadonlySet<ContextKey> = new Set<PresenceKey>([
  "mainWindow",
  "overlayWindow",
  "plannerOverlayWindow",
  "rivenOverlayLeftWindow",
  "rivenOverlayRightWindow",
  "tradeNotificationWindow",
  "arbiSummaryWindow",
  "currentInventoryPath",
  "watcher",
]);
const quotedKeys: ReadonlySet<ContextKey> = new Set<QuotedKey>([
  "overlayHotkeyRegistered",
  "overlayInteractionHotkeyRegistered",
]);

const state: MainProcessContext = {
  mainWindow: null,
  overlayWindow: null,
  plannerOverlayWindow: null,
  rivenOverlayLeftWindow: null,
  rivenOverlayRightWindow: null,
  tradeNotificationWindow: null,
  arbiSummaryWindow: null,
  currentInventoryPath: null,
  currentInventoryData: null,
  watcher: null,
  overlaySettings: { ...OVERLAY_SETTINGS_DEFAULTS } as OverlaySettings,
  overlayThemeVars: {},
  overlayHotkeyRegistered: null,
  overlayInteractionHotkeyRegistered: null,
  overlayInteractiveMode: false,
  overlayDismissedUntilMs: 0,
};

function normalizeValue(key: ContextKey, value: unknown): unknown {
  if (key === "overlayInteractiveMode") return Boolean(value);
  if (key === "overlayDismissedUntilMs") {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  return value;
}

function describePresence(value: unknown): string {
  return value ? "set" : "null";
}

function logAssignment(key: ContextKey, previous: unknown, next: unknown): void {
  if (presenceKeys.has(key)) {
    log.info(`${key} ${describePresence(previous)} -> ${describePresence(next)}`);
    return;
  }

  if (quotedKeys.has(key)) {
    log.info(`${key} "${previous}" -> "${next}"`);
    return;
  }

  if (key === "overlayInteractiveMode" && previous !== next) {
    log.info(`${key} ${previous} -> ${next}`);
  }
}

const ctx = new Proxy(state, {
  set(target, property, value) {
    if (typeof property !== "string" || !Object.prototype.hasOwnProperty.call(target, property)) {
      return false;
    }

    const key = property as ContextKey;
    const previous = target[key];
    const next = normalizeValue(key, value);
    logAssignment(key, previous, next);
    return Reflect.set(target, key, next);
  },
}) as MainProcessContext;

export default ctx;
