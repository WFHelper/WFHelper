import ctx from "./context";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { withScope } from "../services/logger";
import * as worldStateParser from "../services/worldStateParser";
import { normalizeErrorMessage } from "../config/shared/errors";
import { DB_GET_WORLD_STATE, WORLD_STATE_FETCH_ERROR } from "../config/shared/ipcChannels";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const log = withScope("worldStateIpc");

/** Must match the value set in main.ts via app.setAppUserModelId(). */
const APP_USER_MODEL_ID = "com.warframe.companion";

const electronModule = require("electron") as Partial<typeof import("electron")>;
let notificationCtor = electronModule.Notification;
let desktopNotificationSender: ((title: string, body: string) => void) | null = null;

const WORLD_STATE_TTL_MS = 90_000;

let _worldStateCache: unknown = null;
let _worldStateCacheTime = 0;
let _registered = false;
let _startupSeedTimer: ReturnType<typeof setTimeout> | null = null;
let _preCycleInterval: ReturnType<typeof setInterval> | null = null;
let _refreshInterval: ReturnType<typeof setInterval> | null = null;
let _worldNotificationSnapshot: {
  baroActive: boolean;
  baroExpiry: string | null;
  varziaExpiry: string | null;
  varziaLocation: string | null;
  earthIsDay: boolean | null;
  earthExpiry: string | null;
  cetusIsDay: boolean | null;
  cetusExpiry: string | null;
  vallisIsWarm: boolean | null;
  vallisExpiry: string | null;
  cambionActive: string | null;
  cambionExpiry: string | null;
  duviriState: string | null;
  duviriExpiry: string | null;
  fissureIds: Set<string>;
} | null = null;

// Track which upcoming cycle expiries we've already sent a "heads up" notification for,
// keyed by "{cycle}:{expiryIso}" so we don't repeat within the same cycle.
const _cyclePreNotified = new Set<string>();

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
  const duviriCycle =
    stateRecord.duviriCycle && typeof stateRecord.duviriCycle === "object"
      ? (stateRecord.duviriCycle as Record<string, unknown>)
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
    earthExpiry: earthCycle
      ? typeof earthCycle.expiry === "string"
        ? earthCycle.expiry
        : null
      : null,
    cetusIsDay: cetusCycle
      ? typeof cetusCycle.isDay === "boolean"
        ? cetusCycle.isDay
        : null
      : null,
    cetusExpiry: cetusCycle
      ? typeof cetusCycle.expiry === "string"
        ? cetusCycle.expiry
        : null
      : null,
    vallisIsWarm: vallisCycle
      ? typeof vallisCycle.isWarm === "boolean"
        ? vallisCycle.isWarm
        : null
      : null,
    vallisExpiry: vallisCycle
      ? typeof vallisCycle.expiry === "string"
        ? vallisCycle.expiry
        : null
      : null,
    cambionActive: cambionCycle
      ? typeof cambionCycle.active === "string"
        ? cambionCycle.active.toLowerCase()
        : null
      : null,
    cambionExpiry: cambionCycle
      ? typeof cambionCycle.expiry === "string"
        ? cambionCycle.expiry
        : null
      : null,
    duviriState: duviriCycle
      ? typeof duviriCycle.state === "string"
        ? duviriCycle.state.toLowerCase()
        : null
      : null,
    duviriExpiry: duviriCycle
      ? typeof duviriCycle.expiry === "string"
        ? duviriCycle.expiry
        : null
      : null,
    fissureIds,
  };
}

function canSendNotifications(): boolean {
  if (process.platform === "win32") return true;
  if (!notificationCtor) {
    notificationCtor = electronModule.Notification;
  }
  if (typeof notificationCtor !== "function") return false;
  if (typeof (notificationCtor as { isSupported?: () => boolean }).isSupported === "function") {
    return (notificationCtor as { isSupported: () => boolean }).isSupported();
  }
  return true;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Ensure a Start Menu shortcut exists with our AUMID so Windows treats us
 * as a properly registered app for toast notifications and Focus Assist.
 */
function ensureStartMenuShortcut(): void {
  if (process.platform !== "win32") return;
  try {
    const { shell } = require("electron") as typeof import("electron");
    if (
      !shell ||
      typeof shell.readShortcutLink !== "function" ||
      typeof shell.writeShortcutLink !== "function"
    ) {
      return;
    }
    const startMenuDir = path.join(
      process.env.APPDATA || "",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
    );
    const lnkPath = path.join(startMenuDir, "WFHelper.lnk");

    // Read existing shortcut to check if it already has the correct target + AUMID.
    let needWrite = true;
    if (fs.existsSync(lnkPath)) {
      try {
        const existing = shell.readShortcutLink(lnkPath);
        if (existing.target === process.execPath && existing.appUserModelId === APP_USER_MODEL_ID) {
          needWrite = false;
        }
      } catch {
        /* corrupt / unreadable - recreate */
      }
    }

    if (needWrite) {
      shell.writeShortcutLink(lnkPath, "create", {
        target: process.execPath,
        appUserModelId: APP_USER_MODEL_ID,
        description: "WFHelper",
      });
      log.info("[WorldState] created/updated Start Menu shortcut for notifications");
    }
  } catch (err) {
    log.warn("[WorldState] Start Menu shortcut error:", normalizeErrorMessage(err));
  }
}

/** Auto-incrementing tag counter so each toast gets a unique tag for History.Remove(). */
let _toastTagCounter = 0;

/** Duration in ms before auto-dismissing an incomingCall toast banner. */
const TOAST_DISMISS_MS = 5_000;

const SHOW_TOAST_SCRIPT = [
  "param([string]$XmlPath, [string]$Tag, [string]$Group, [string]$AppId)",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
  "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$x.LoadXml((Get-Content -LiteralPath $XmlPath -Raw))",
  "$t = [Windows.UI.Notifications.ToastNotification]::new($x)",
  "$t.Tag = $Tag",
  "$t.Group = $Group",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($t)",
  "",
].join("\n");

const REMOVE_TOAST_SCRIPT = [
  "param([string]$Tag, [string]$Group, [string]$AppId)",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "[Windows.UI.Notifications.ToastNotificationManager]::History.Remove($Tag, $Group, $AppId)",
  "",
].join("\n");

function writeToastScript(kind: "show" | "remove", tag: string): string | null {
  const scriptPath = path.join(
    os.tmpdir(),
    `wfc-toast-${kind}-${process.pid}-${Date.now()}-${tag}.ps1`,
  );
  try {
    fs.writeFileSync(scriptPath, kind === "show" ? SHOW_TOAST_SCRIPT : REMOVE_TOAST_SCRIPT, "utf8");
    return scriptPath;
  } catch (err) {
    log.warn("[WorldState] toast script temp file error:", normalizeErrorMessage(err));
    return null;
  }
}

/** Send a Windows toast via PowerShell WinRT. Uses scenario="incomingCall" to
 *  bypass Focus Assist "Priority only" filtering, then auto-dismisses the
 *  toast after TOAST_DISMISS_MS so it behaves like a normal notification. */
function notificationSoundEnabled(): boolean {
  return ctx.overlaySettings.notificationSoundEnabled !== false;
}

function sendWindowsToast(title: string, body: string): void {
  const tag = `wfc-${++_toastTagCounter}`;
  const group = "wfc";
  const audioXml = notificationSoundEnabled()
    ? '<audio src="ms-winsoundevent:Notification.Default"/>'
    : '<audio silent="true"/>';
  const xml = `<toast scenario="incomingCall"><visual><binding template="ToastGeneric"><text>${escapeXml(
    title,
  )}</text><text>${escapeXml(body)}</text></binding></visual>${audioXml}</toast>`;
  const xmlPath = path.join(os.tmpdir(), `wfc-toast-${process.pid}-${Date.now()}-${tag}.xml`);
  try {
    fs.writeFileSync(xmlPath, xml, "utf8");
  } catch (err) {
    log.warn("[WorldState] toast temp file error:", normalizeErrorMessage(err));
    return;
  }

  const showScriptPath = writeToastScript("show", tag);
  if (!showScriptPath) {
    fs.unlink(xmlPath, () => {});
    return;
  }
  execFile(
    "powershell.exe",
    [
      "-ExecutionPolicy",
      "Bypass",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      showScriptPath,
      xmlPath,
      tag,
      group,
      APP_USER_MODEL_ID,
    ],
    { windowsHide: true, timeout: 8000 },
    (err) => {
      if (err) log.warn("[WorldState] toast error:", normalizeErrorMessage(err));
      fs.unlink(xmlPath, () => {});
      fs.unlink(showScriptPath, () => {});
    },
  );

  // Auto-dismiss: remove the toast from the notification center after the
  // banner display time so it doesn't stick around like a phone call.
  setTimeout(() => {
    const removeScriptPath = writeToastScript("remove", tag);
    if (!removeScriptPath) return;
    execFile(
      "powershell.exe",
      [
        "-ExecutionPolicy",
        "Bypass",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        removeScriptPath,
        tag,
        group,
        APP_USER_MODEL_ID,
      ],
      { windowsHide: true, timeout: 5000 },
      () => {
        fs.unlink(removeScriptPath, () => {});
      },
    );
  }, TOAST_DISMISS_MS);
}

// Keep references to active notifications to prevent GC before display.
const _activeNotifications = new Set<{ close: () => void }>();

function sendDesktopNotification(title: string, body: string): void {
  if (ctx.overlaySettings.worldNotificationsEnabled === false) return;
  sendDesktopNotificationRaw(title, body);
}

/**
 * Ungated desktop toast, reused by in-game message notifications which apply
 * their own settings gate. Respects platform + canSendNotifications().
 */
export function sendDesktopNotificationRaw(title: string, body: string): void {
  try {
    if (!canSendNotifications()) return;
    log.info("[WorldState] sending notification:", title, "-", body);
    if (desktopNotificationSender) {
      desktopNotificationSender(title, body);
      return;
    }
    if (process.platform === "win32") {
      sendWindowsToast(title, body);
      return;
    }
    const ElectronNotification = notificationCtor || electronModule.Notification;
    if (typeof ElectronNotification !== "function") return;
    const notification = new ElectronNotification({
      title,
      body,
      silent: !notificationSoundEnabled(),
    });
    _activeNotifications.add(notification);
    const release = () => {
      _activeNotifications.delete(notification);
    };
    notification.on("failed", (_event: unknown, error: string) => {
      log.warn("[WorldState] notification FAILED:", title, error);
      release();
    });
    notification.on("close", () => {
      release();
    });
    setTimeout(release, 30_000);
    notification.show();
  } catch (err) {
    log.warn("[WorldState] notification error:", normalizeErrorMessage(err));
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
  const cycleAlerts = ctx.overlaySettings?.cycleAlerts ?? {
    earth: false,
    cetus: false,
    vallis: false,
    cambion: false,
    duviri: false,
  };

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

  if (
    cycleAlerts.duviri &&
    prev.duviriState !== null &&
    next.duviriState !== null &&
    prev.duviriState !== next.duviriState
  ) {
    const label = next.duviriState
      ? next.duviriState.charAt(0).toUpperCase() + next.duviriState.slice(1)
      : "Unknown";
    sendDesktopNotification("Duviri Cycle", `${label} mood has begun.`);
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
        const tierOk = rule.tier === "any" || rule.tier.toLowerCase() === tier.toLowerCase();
        const missionOk =
          rule.missionType === "any" ||
          rule.missionType.toLowerCase() === missionType.toLowerCase();
        const spOk =
          rule.steelPath === "any" ||
          (rule.steelPath === "steel" && isHard) ||
          (rule.steelPath === "normal" && !isHard);
        const planetOk =
          !rule.planet ||
          rule.planet === "any" ||
          node.toLowerCase().includes(`(${rule.planet.toLowerCase()})`);
        return tierOk && missionOk && spOk && planetOk;
      });

      if (matches) {
        const spLabel = isHard ? " (Steel Path)" : "";
        const nodeLabel = node || "Unknown Node";
        sendDesktopNotification("Fissure Alert", `${tier} ${missionType}${spLabel} - ${nodeLabel}`);
      }
    }
  }
}

/**
 * Time-based pre-cycle notifications. Runs on EVERY poll (including cached
 * responses) so we never miss the lead-time window. Transition detection
 * stays in maybeNotifyWorldEvents which only runs on fresh fetches.
 */
function checkPreCycleNotifications(state: unknown): void {
  if (!canSendNotifications()) return;

  const cycleAlerts = ctx.overlaySettings?.cycleAlerts ?? {
    earth: false,
    cetus: false,
    vallis: false,
    cambion: false,
    duviri: false,
  };
  const leadMinutes = ctx.overlaySettings?.cycleAlertMinutesBefore ?? 3;
  if (leadMinutes <= 0) return;

  const leadMs = leadMinutes * 60_000;
  const nowMs = Date.now();

  const snap = _worldNotificationSnapshot ?? buildNotificationSnapshot(state);

  const upcomingCycles: { key: string; enabled: boolean; expiry: string | null; label: string }[] =
    [
      {
        key: "earth",
        enabled: !!cycleAlerts.earth,
        expiry: snap.earthExpiry,
        label: snap.earthIsDay ? "Night" : "Day",
      },
      {
        key: "cetus",
        enabled: !!cycleAlerts.cetus,
        expiry: snap.cetusExpiry,
        label: snap.cetusIsDay ? "Night" : "Day",
      },
      {
        key: "vallis",
        enabled: !!cycleAlerts.vallis,
        expiry: snap.vallisExpiry,
        label: snap.vallisIsWarm ? "Cold" : "Warm",
      },
      {
        key: "cambion",
        enabled: !!cycleAlerts.cambion,
        expiry: snap.cambionExpiry,
        label: snap.cambionActive === "fass" ? "VOME" : "FASS",
      },
      {
        key: "duviri",
        enabled: !!cycleAlerts.duviri,
        expiry: snap.duviriExpiry,
        label: snap.duviriState
          ? snap.duviriState.charAt(0).toUpperCase() + snap.duviriState.slice(1)
          : "Unknown",
      },
    ];

  for (const c of upcomingCycles) {
    if (!c.enabled || !c.expiry) continue;
    const expiryMs = Date.parse(c.expiry);
    if (!Number.isFinite(expiryMs)) continue;
    const remaining = expiryMs - nowMs;
    const preKey = `${c.key}:${c.expiry}`;
    if (remaining > 0 && remaining <= leadMs && !_cyclePreNotified.has(preKey)) {
      _cyclePreNotified.add(preKey);
      const mins = Math.ceil(remaining / 60_000);
      const cycleName = c.key.charAt(0).toUpperCase() + c.key.slice(1);
      sendDesktopNotification(
        `${cycleName} Cycle`,
        `${c.label} in ~${mins} min${mins !== 1 ? "s" : ""}.`,
      );
    }
    // Evict old entries to prevent memory growth
    if (remaining < -300_000) _cyclePreNotified.delete(preKey);
  }
}

function clearRegisteredTimers(): void {
  if (_startupSeedTimer) {
    clearTimeout(_startupSeedTimer);
    _startupSeedTimer = null;
  }
  if (_preCycleInterval) {
    clearInterval(_preCycleInterval);
    _preCycleInterval = null;
  }
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
  }
}

function resetForTest(): void {
  clearRegisteredTimers();
  _registered = false;
  _worldStateCache = null;
  _worldStateCacheTime = 0;
  _worldNotificationSnapshot = null;
  _cyclePreNotified.clear();
  notificationCtor = electronModule.Notification;
  desktopNotificationSender = null;
}

function setDesktopNotificationSenderForTest(
  sender: ((title: string, body: string) => void) | null,
): void {
  desktopNotificationSender = sender;
}

function expireWorldStateCacheForTest(): void {
  _worldStateCacheTime = 0;
}

function register(
  options: {
    ipcMain?: { handle?: (channel: string, handler: (event: unknown) => Promise<unknown>) => void };
    Notification?: unknown;
  } = {},
): void {
  if (Object.prototype.hasOwnProperty.call(options, "Notification")) {
    notificationCtor = options.Notification as typeof notificationCtor;
  }

  if (_registered) return;

  const ipc = options.ipcMain || electronModule.ipcMain;
  if (!ipc || typeof ipc.handle !== "function") {
    throw new Error("IPC main bridge is unavailable");
  }

  ipc.handle(DB_GET_WORLD_STATE, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_GET_WORLD_STATE);

    const now = Date.now();
    if (_worldStateCache && now - _worldStateCacheTime < WORLD_STATE_TTL_MS) {
      checkPreCycleNotifications(_worldStateCache);
      return _worldStateCache;
    }

    try {
      _worldStateCache = await worldStateParser.fetchAndParse();
      _worldStateCacheTime = Date.now();
      maybeNotifyWorldEvents(_worldStateCache);
      checkPreCycleNotifications(_worldStateCache);
      log.info("[WorldState] Fetched and parsed DE world state");
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
  _registered = true;

  // Ensure we have a Start Menu shortcut so Windows recognises us for
  // toast notifications under Focus Assist "Priority only" mode.
  ensureStartMenuShortcut();

  // Seed the world state cache shortly after startup so cycle notifications
  // work immediately, even before the user visits the World tab.
  _startupSeedTimer = setTimeout(async () => {
    _startupSeedTimer = null;
    try {
      _worldStateCache = await worldStateParser.fetchAndParse();
      _worldStateCacheTime = Date.now();
      _worldNotificationSnapshot = buildNotificationSnapshot(_worldStateCache);
      checkPreCycleNotifications(_worldStateCache);
      log.info("[WorldState] startup seed complete");
    } catch (err) {
      log.warn("[WorldState] startup seed failed:", normalizeErrorMessage(err));
    }
  }, 3_000);

  // Check cached world state every 15 s so we catch the moment a cycle
  // enters the lead-time window without waiting for a full re-fetch.
  _preCycleInterval = setInterval(() => {
    if (_worldStateCache) checkPreCycleNotifications(_worldStateCache);
  }, 15_000);

  // Re-fetch world state every 60 s in the background so the cache stays
  // current and transition notifications fire correctly.
  _refreshInterval = setInterval(async () => {
    try {
      const fresh = await worldStateParser.fetchAndParse();
      _worldStateCache = fresh;
      _worldStateCacheTime = Date.now();
      maybeNotifyWorldEvents(fresh);
      checkPreCycleNotifications(fresh);
    } catch {
      /* logged at fetch layer */
    }
  }, 60_000);
}

const __test__ = {
  reset: resetForTest,
  setDesktopNotificationSender: setDesktopNotificationSenderForTest,
  expireCache: expireWorldStateCacheForTest,
};

export { register, __test__ };
