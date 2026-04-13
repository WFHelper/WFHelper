import ctx from "./context";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { withScope } from "../services/logger";
import * as worldStateParser from "../services/worldStateParser";
import { normalizeErrorMessage } from "../config/shared/errors";
import { DB_GET_WORLD_STATE, WORLD_STATE_FETCH_ERROR } from "../config/shared/ipcChannels";

const log = withScope("worldStateIpc");

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
  earthIsDay: boolean | null;
  cetusIsDay: boolean | null;
  vallisIsWarm: boolean | null;
  cambionActive: string | null;
  fissureIds: Set<string>;
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

  const earthCycle =
    stateRecord.earthCycle && typeof stateRecord.earthCycle === "object"
      ? (stateRecord.earthCycle as Record<string, unknown>)
      : null;
  const cetusCycle =
    stateRecord.cetusCycle && typeof stateRecord.cetusCycle === "object"
      ? (stateRecord.cetusCycle as Record<string, unknown>)
      : null;
  const vallisCycle =
    stateRecord.vallisCycle && typeof stateRecord.vallisCycle === "object"
      ? (stateRecord.vallisCycle as Record<string, unknown>)
      : null;
  const cambionCycle =
    stateRecord.cambionCycle && typeof stateRecord.cambionCycle === "object"
      ? (stateRecord.cambionCycle as Record<string, unknown>)
      : null;

  const rawFissures = Array.isArray(stateRecord.fissures)
    ? (stateRecord.fissures as unknown[])
    : [];
  const fissureIds = new Set(
    rawFissures
      .filter((f) => {
        if (!f || typeof f !== "object") return false;
        const fr = f as Record<string, unknown>;
        return fr.expired !== true;
      })
      .map((f) => {
        const fr = f as Record<string, unknown>;
        const tier = typeof fr.tier === "string" ? fr.tier : "";
        const node = typeof fr.node === "string" ? fr.node : "";
        const expiry = typeof fr.expiry === "string" ? fr.expiry : "";
        const isHard = fr.isHard === true ? "1" : "0";
        return `${tier}|${node}|${expiry}|${isHard}`;
      }),
  );

  return {
    baroActive: isTraderActive(voidTrader, nowMs),
    baroExpiry: typeof voidTrader.expiry === "string" ? voidTrader.expiry : null,
    varziaExpiry: typeof vaultTrader.expiry === "string" ? vaultTrader.expiry : null,
    varziaLocation: typeof vaultTrader.location === "string" ? vaultTrader.location : "Varzia",
    earthIsDay: earthCycle
      ? typeof earthCycle.isDay === "boolean"
        ? earthCycle.isDay
        : null
      : null,
    cetusIsDay: cetusCycle
      ? typeof cetusCycle.isDay === "boolean"
        ? cetusCycle.isDay
        : null
      : null,
    vallisIsWarm: vallisCycle
      ? typeof vallisCycle.isWarm === "boolean"
        ? vallisCycle.isWarm
        : null
      : null,
    cambionActive: cambionCycle
      ? typeof cambionCycle.active === "string"
        ? cambionCycle.active.toLowerCase()
        : null
      : null,
    fissureIds,
  };
}

function canSendNotifications(): boolean {
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

  // Per-cycle transition notifications (opt-in via cycleAlerts settings)
  const cycleAlerts = ctx.overlaySettings?.cycleAlerts ?? { earth: false, cetus: false, vallis: false, cambion: false };

  if (
    cycleAlerts.earth &&
    prev.earthIsDay !== null &&
    next.earthIsDay !== null &&
    prev.earthIsDay !== next.earthIsDay
  ) {
    sendDesktopNotification("Earth Cycle", next.earthIsDay ? "Day has begun." : "Night has begun.");
  }

  if (
    cycleAlerts.cetus &&
    prev.cetusIsDay !== null &&
    next.cetusIsDay !== null &&
    prev.cetusIsDay !== next.cetusIsDay
  ) {
    sendDesktopNotification("Cetus Cycle", next.cetusIsDay ? "Day has begun." : "Night has begun.");
  }

  if (
    cycleAlerts.vallis &&
    prev.vallisIsWarm !== null &&
    next.vallisIsWarm !== null &&
    prev.vallisIsWarm !== next.vallisIsWarm
  ) {
    sendDesktopNotification(
      "Orb Vallis Cycle",
      next.vallisIsWarm ? "Warm cycle has begun." : "Cold cycle has begun.",
    );
  }

  if (
    cycleAlerts.cambion &&
    prev.cambionActive !== null &&
    next.cambionActive !== null &&
    prev.cambionActive !== next.cambionActive
  ) {
    const label = next.cambionActive ? next.cambionActive.toUpperCase() : "Unknown";
    sendDesktopNotification("Cambion Drift Cycle", `${label} cycle has begun.`);
  }

  // Fissure appearance alerts (opt-in per configured alert rules)
  const fissureAlertRules = ctx.overlaySettings?.fissureAlerts;
  if (Array.isArray(fissureAlertRules) && fissureAlertRules.length > 0) {

    const rawFissures = Array.isArray(stateRecord.fissures)
      ? (stateRecord.fissures as unknown[])
      : [];

    for (const f of rawFissures) {
      if (!f || typeof f !== "object") continue;
      const fr = f as Record<string, unknown>;
      if (fr.expired === true) continue;

      const tier = typeof fr.tier === "string" ? fr.tier : "";
      const node = typeof fr.node === "string" ? fr.node : "";
      const expiry = typeof fr.expiry === "string" ? fr.expiry : "";
      const isHard = fr.isHard === true;
      const isHardStr = isHard ? "1" : "0";
      const fissureId = `${tier}|${node}|${expiry}|${isHardStr}`;

      // Only notify for newly appeared fissures
      if (prev.fissureIds.has(fissureId)) continue;

      const missionType = typeof fr.missionType === "string" ? fr.missionType : "";

      const matches = fissureAlertRules.some((rule) => {
        const tierOk =
          rule.tier === "any" || rule.tier.toLowerCase() === tier.toLowerCase();
        const missionOk =
          rule.missionType === "any" ||
          rule.missionType.toLowerCase() === missionType.toLowerCase();
        const spOk =
          rule.steelPath === "any" ||
          (rule.steelPath === "steel" && isHard) ||
          (rule.steelPath === "normal" && !isHard);
        return tierOk && missionOk && spOk;
      });

      if (matches) {
        const spLabel = isHard ? " (Steel Path)" : "";
        const nodeLabel = node || "Unknown Node";
        sendDesktopNotification(
          "Fissure Alert",
          `${tier} ${missionType}${spLabel} — ${nodeLabel}`,
        );
      }
    }
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

  ipc.handle(DB_GET_WORLD_STATE, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_GET_WORLD_STATE);

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
      const msg = normalizeErrorMessage(err);
      log.error("[WorldState] fetch failed:", msg);
      ctx.mainWindow?.webContents.send(WORLD_STATE_FETCH_ERROR, msg);
      if (!_worldStateCache) {
        _worldStateCache = worldStateParser.emptyWorldState();
      }
      return _worldStateCache;
    }
  });
}

export { register };
