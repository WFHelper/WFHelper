import ctx from "./context";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { createRuntimeRequire } from "./runtimeRequire";

export {};

const requireRuntime = createRuntimeRequire(__dirname, 1);

const log = requireRuntime<{
  withScope: (scope: string) => {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}>("services/logger").withScope("worldStateIpc");

const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");

const worldStateParser = requireRuntime<{
  fetchAndParse: () => Promise<unknown>;
  emptyWorldState: () => unknown;
}>("services/worldStateParser");
function getElectronModule(): Partial<typeof import("electron")> {
  const loaded = require("electron") as unknown;
  if (loaded && typeof loaded === "object") {
    return loaded as Partial<typeof import("electron")>;
  }
  return {};
}

const electronModule = getElectronModule();
let notificationCtor = electronModule.Notification;

const WORLD_STATE_TTL_MS = 90_000;

let _worldStateCache: unknown = null;
let _worldStateCacheTime = 0;
let _worldNotificationSnapshot: {
  baroActive: boolean;
  baroExpiry: string | null;
  varziaExpiry: string | null;
  varziaLocation: string | null;
} | null = null;

function parseIsoMs(value: unknown): number | null {
  if (!value || typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isTraderActive(trader: unknown, nowMs: number): boolean {
  if (!trader || typeof trader !== "object") return false;
  const traderRecord = trader as Record<string, unknown>;
  const activationMs = parseIsoMs(traderRecord.activation);
  const expiryMs = parseIsoMs(traderRecord.expiry);
  if (!expiryMs) return false;
  if (activationMs && nowMs < activationMs) return false;
  return nowMs < expiryMs;
}

function buildNotificationSnapshot(state: unknown) {
  const nowMs = Date.now();
  const stateRecord = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  const voidTrader =
    stateRecord.voidTrader && typeof stateRecord.voidTrader === "object"
      ? (stateRecord.voidTrader as Record<string, unknown>)
      : {};
  const vaultTrader =
    stateRecord.vaultTrader && typeof stateRecord.vaultTrader === "object"
      ? (stateRecord.vaultTrader as Record<string, unknown>)
      : {};

  return {
    baroActive: isTraderActive(voidTrader, nowMs),
    baroExpiry: typeof voidTrader.expiry === "string" ? voidTrader.expiry : null,
    varziaExpiry: typeof vaultTrader.expiry === "string" ? vaultTrader.expiry : null,
    varziaLocation: typeof vaultTrader.location === "string" ? vaultTrader.location : "Varzia",
  };
}

function canSendNotifications(): boolean {
  if (!ctx.overlaySettings?.worldNotificationsEnabled) return false;
  if (typeof notificationCtor !== "function") return false;
  if (typeof (notificationCtor as { isSupported?: () => boolean }).isSupported === "function") {
    return (notificationCtor as { isSupported: () => boolean }).isSupported();
  }
  return true;
}

function sendDesktopNotification(title: string, body: string): void {
  try {
    const NotificationCtor = notificationCtor as {
      new (options: { title: string; body: string; silent: boolean }): { show: () => void };
    };
    const notification = new NotificationCtor({
      title,
      body,
      silent: false,
    });
    notification.show();
  } catch (err) {
    log.warn("[WorldState] notification failed:", normalizeErrorMessage(err));
  }
}

function maybeNotifyWorldEvents(state: unknown): void {
  const next = buildNotificationSnapshot(state);

  if (_worldNotificationSnapshot == null) {
    _worldNotificationSnapshot = next;
    return;
  }

  const prev = _worldNotificationSnapshot;
  _worldNotificationSnapshot = next;

  if (!canSendNotifications()) return;

  const stateRecord = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  const voidTrader =
    stateRecord.voidTrader && typeof stateRecord.voidTrader === "object"
      ? (stateRecord.voidTrader as Record<string, unknown>)
      : {};

  if (!prev.baroActive && next.baroActive) {
    const location =
      typeof voidTrader.location === "string" && voidTrader.location
        ? voidTrader.location
        : "Relay";
    sendDesktopNotification("Baro Ki'Teer Arrived", `Now available at ${location}.`);
  }

  if (prev.varziaExpiry && next.varziaExpiry && prev.varziaExpiry !== next.varziaExpiry) {
    sendDesktopNotification(
      "Prime Resurgence Rotation Updated",
      `New rotation at ${next.varziaLocation || "Varzia"}.`,
    );
  }
}

function register(
  options: {
    ipcMain?: { handle?: (channel: string, handler: (event: unknown) => Promise<unknown>) => void };
    Notification?: unknown;
  } = {},
): void {
  const ipc = options.ipcMain || electronModule.ipcMain;
  if (!ipc || typeof ipc.handle !== "function") {
    throw new Error("IPC main bridge is unavailable");
  }

  if (Object.prototype.hasOwnProperty.call(options, "Notification")) {
    notificationCtor = options.Notification as typeof notificationCtor;
  }

  ipc.handle("get-world-state", async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "get-world-state");

    const now = Date.now();
    if (_worldStateCache && now - _worldStateCacheTime < WORLD_STATE_TTL_MS) {
      return _worldStateCache;
    }

    try {
      _worldStateCache = await worldStateParser.fetchAndParse();
      _worldStateCacheTime = Date.now();
      maybeNotifyWorldEvents(_worldStateCache);
      log.log("[WorldState] Fetched and parsed DE world state");
      return _worldStateCache;
    } catch (err) {
      log.error("[WorldState] fetch failed:", normalizeErrorMessage(err));
      if (!_worldStateCache) {
        _worldStateCache = worldStateParser.emptyWorldState();
      }
      return _worldStateCache;
    }
  });
}

export { register };

module.exports = { register };
