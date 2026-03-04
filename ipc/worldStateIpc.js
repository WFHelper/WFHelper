const log = require("../services/logger").withScope("worldStateIpc");
/**
 * World state IPC handler with TTL cache.
 * Handles: get-world-state
 */

const worldStateParser = require("../services/worldStateParser");
const ctx = require("./context");
const { assertMainRendererSender, assertAuthorizedSender } = require("./ipcSecurity");

function getElectronModule() {
  const loaded = require("electron");
  if (loaded && typeof loaded === "object") return loaded;
  return {};
}

const electronModule = getElectronModule();
let notificationCtor = electronModule.Notification;

const WORLD_STATE_TTL_MS = 90_000;

let _worldStateCache = null;
let _worldStateCacheTime = 0;
let _worldNotificationSnapshot = null;

function parseIsoMs(value) {
  if (!value || typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isTraderActive(trader, nowMs) {
  if (!trader || typeof trader !== "object") return false;
  const activationMs = parseIsoMs(trader.activation);
  const expiryMs = parseIsoMs(trader.expiry);
  if (!expiryMs) return false;
  if (activationMs && nowMs < activationMs) return false;
  return nowMs < expiryMs;
}

function buildNotificationSnapshot(state) {
  const nowMs = Date.now();
  return {
    baroActive: isTraderActive(state?.voidTrader, nowMs),
    baroExpiry: state?.voidTrader?.expiry || null,
    varziaExpiry: state?.vaultTrader?.expiry || null,
    varziaLocation: state?.vaultTrader?.location || "Varzia",
  };
}

function canSendNotifications() {
  if (!ctx.overlaySettings?.worldNotificationsEnabled) return false;
  if (typeof notificationCtor !== "function") return false;
  if (typeof notificationCtor.isSupported === "function") {
    return notificationCtor.isSupported();
  }
  return true;
}

function sendDesktopNotification(title, body) {
  try {
    const notification = new notificationCtor({
      title,
      body,
      silent: false,
    });
    notification.show();
  } catch (err) {
    log.warn("[WorldState] notification failed:", err.message);
  }
}

function maybeNotifyWorldEvents(state) {
  const next = buildNotificationSnapshot(state);

  if (_worldNotificationSnapshot == null) {
    _worldNotificationSnapshot = next;
    return;
  }

  const prev = _worldNotificationSnapshot;
  _worldNotificationSnapshot = next;

  if (!canSendNotifications()) return;

  if (!prev.baroActive && next.baroActive) {
    const location = state?.voidTrader?.location || "Relay";
    sendDesktopNotification("Baro Ki'Teer Arrived", `Now available at ${location}.`);
  }

  if (prev.varziaExpiry && next.varziaExpiry && prev.varziaExpiry !== next.varziaExpiry) {
    sendDesktopNotification(
      "Prime Resurgence Rotation Updated",
      `New rotation at ${next.varziaLocation || "Varzia"}.`,
    );
  }
}

function register(options = {}) {
  const ipc = options.ipcMain || electronModule.ipcMain;
  if (!ipc || typeof ipc.handle !== "function") {
    throw new Error("IPC main bridge is unavailable");
  }

  if (Object.prototype.hasOwnProperty.call(options, "Notification")) {
    notificationCtor = options.Notification;
  }

  ipc.handle("get-world-state", async (event) => {
    assertAuthorizedSender(assertMainRendererSender, event, "get-world-state");

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
      log.error("[WorldState] fetch failed:", err.message);
      // Fall back to stale data if available, otherwise return a safe empty shape
      if (!_worldStateCache) {
        _worldStateCache = worldStateParser.emptyWorldState();
      }
      return _worldStateCache;
    }
  });
}

module.exports = { register };
