import ctx from "./context";
import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { asRecord } from "./ipcValidators";
import { recordNotification } from "./notificationLogIpc";
import { sendToPopouts } from "./popoutIpc";
import type { NotificationKind } from "../config/shared/notifications";
import { withScope } from "../services/logger";
import { dispatch } from "../services/notificationChannels";
import * as worldStateParser from "../services/worldStateParser";
import { normalizeErrorMessage } from "../config/shared/errors";
import { durationMsFromSeconds } from "../config/shared/numeric";
import {
  DB_GET_WORLD_STATE,
  NOTIFICATION_SOUND_PLAY,
  NOTIFICATION_TEST,
  WORLD_STATE_FETCH_ERROR,
} from "../config/shared/ipcChannels";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const log = withScope("worldStateIpc");

import { WIN_APP_USER_MODEL_ID as APP_USER_MODEL_ID } from "../config/shared/appMeta";

const electronModule = require("electron") as Partial<typeof import("electron")>;
let notificationCtor = electronModule.Notification;
let desktopNotificationSender: ((title: string, body: string) => void) | null = null;

const WORLD_STATE_TTL_MS = 90_000;

let _worldStateCache: unknown = null;
let _worldStateCacheTime = 0;
let _worldStateFetch: Promise<unknown> | null = null;
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

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseIsoMs(value: unknown): number | null {
  if (!value || typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isTraderActive(trader: Record<string, unknown>, nowMs: number): boolean {
  const activationMs = parseIsoMs(trader.activation);
  const expiryMs = parseIsoMs(trader.expiry);
  if (!expiryMs) return false;
  if (activationMs && nowMs < activationMs) return false;
  return nowMs < expiryMs;
}

function buildNotificationSnapshot(state: unknown) {
  const nowMs = Date.now();
  const stateRecord = asRecord(state) ?? {};
  const voidTrader = asRecord(stateRecord.voidTrader) ?? {};
  const vaultTrader = asRecord(stateRecord.vaultTrader) ?? {};
  const earthCycle = asRecord(stateRecord.earthCycle);
  const cetusCycle = asRecord(stateRecord.cetusCycle);
  const vallisCycle = asRecord(stateRecord.vallisCycle);
  const cambionCycle = asRecord(stateRecord.cambionCycle);
  const duviriCycle = asRecord(stateRecord.duviriCycle);

  const rawFissures = Array.isArray(stateRecord.fissures)
    ? (stateRecord.fissures as unknown[])
    : [];
  const fissureIds = new Set(
    rawFissures
      .map(asRecord)
      .filter((fr): fr is Record<string, unknown> => fr !== null && fr.expired !== true)
      .map((fr) => {
        const isHard = fr.isHard === true ? "1" : "0";
        return `${str(fr.tier) ?? ""}|${str(fr.node) ?? ""}|${str(fr.expiry) ?? ""}|${isHard}`;
      }),
  );

  return {
    baroActive: isTraderActive(voidTrader, nowMs),
    baroExpiry: str(voidTrader.expiry),
    varziaExpiry: str(vaultTrader.expiry),
    varziaLocation: str(vaultTrader.location) ?? "Varzia",
    earthIsDay: bool(earthCycle?.isDay),
    earthExpiry: str(earthCycle?.expiry),
    cetusIsDay: bool(cetusCycle?.isDay),
    cetusExpiry: str(cetusCycle?.expiry),
    vallisIsWarm: bool(vallisCycle?.isWarm),
    vallisExpiry: str(vallisCycle?.expiry),
    cambionActive: str(cambionCycle?.active)?.toLowerCase() ?? null,
    cambionExpiry: str(cambionCycle?.expiry),
    duviriState: str(duviriCycle?.state)?.toLowerCase() ?? null,
    duviriExpiry: str(duviriCycle?.expiry),
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

// The AUMID shortcut lets Windows route toasts through Focus Assist correctly.
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

/** Every toast shares one group so quit can pull them all in a single call. */
const TOAST_GROUP = "wfc";

/** Tags already shown and not yet pulled by their dismiss timer. */
const _outstandingToastTags = new Set<string>();

/** Fallback for the configured dismiss delay; an incomingCall toast holds on
 *  screen until it is pulled, so this is what the user actually sees. */
const TOAST_DISMISS_MS = 5_000;

const TOAST_MANAGER_TYPE_LOAD =
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null";

const SHOW_TOAST_SCRIPT = [
  "param([string]$XmlPath, [string]$Tag, [string]$Group, [string]$AppId)",
  TOAST_MANAGER_TYPE_LOAD,
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
  TOAST_MANAGER_TYPE_LOAD,
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

function notificationSoundEnabled(): boolean {
  return ctx.overlaySettings.notificationSoundEnabled !== false;
}

// One sound per toast burst - a batch of fissure alerts would otherwise ring per toast.
const SOUND_MIN_GAP_MS = 3_000;
let _lastSoundAt = 0;

// The two are exclusive on purpose. The app's own clip is billed to WFHelper in
// the volume mixer, so its slider applies; the system sound is billed to System
// Sounds, so that slider applies instead. Neither one obeys both.
const TOAST_SILENT_AUDIO = '<audio silent="true"/>';
const TOAST_SYSTEM_AUDIO = '<audio src="ms-winsoundevent:Notification.Default"/>';

function notificationSoundUsesSystem(): boolean {
  return ctx.overlaySettings.notificationSoundUsesSystem === true;
}

function toastAudio(): string {
  if (!notificationSoundEnabled()) return TOAST_SILENT_AUDIO;
  return notificationSoundUsesSystem() ? TOAST_SYSTEM_AUDIO : TOAST_SILENT_AUDIO;
}

function playNotificationSound(): void {
  if (!notificationSoundEnabled() || notificationSoundUsesSystem()) return;
  const window = ctx.mainWindow;
  if (!window || window.isDestroyed()) return;
  const now = Date.now();
  if (now - _lastSoundAt < SOUND_MIN_GAP_MS) return;
  _lastSoundAt = now;
  try {
    window.webContents.send(NOTIFICATION_SOUND_PLAY);
  } catch (err) {
    log.warn("[WorldState] notification sound push failed:", normalizeErrorMessage(err));
  }
}

// A shown toast lives in Windows, not in this process, so an exit before the
// dismiss timer would strand it on screen. The child outlives us on purpose.
function removeOutstandingToasts(): void {
  if (_outstandingToastTags.size === 0) return;
  _outstandingToastTags.clear();
  try {
    const child = spawn(
      "powershell.exe",
      [
        "-ExecutionPolicy",
        "Bypass",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${TOAST_MANAGER_TYPE_LOAD}; [Windows.UI.Notifications.ToastNotificationManager]::History.RemoveGroup('${TOAST_GROUP}', '${APP_USER_MODEL_ID}')`,
      ],
      { windowsHide: true, detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch (err) {
    log.warn("[WorldState] toast quit cleanup failed:", normalizeErrorMessage(err));
  }
}

function removeToast(tag: string): void {
  if (!_outstandingToastTags.has(tag)) return;
  const removeScriptPath = writeToastScript("remove", tag);
  // Keep the tag on a failed write: dropping it here would strand the toast on
  // screen, because the quit-time group cleanup bails on an empty set.
  if (!removeScriptPath) return;
  _outstandingToastTags.delete(tag);
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
      TOAST_GROUP,
      APP_USER_MODEL_ID,
    ],
    { windowsHide: true, timeout: 5000 },
    (err) => {
      fs.unlink(removeScriptPath, () => {});
      if (!err) return;
      // The toast is still up, so put it back for the quit-time group removal.
      _outstandingToastTags.add(tag);
      log.warn("[WorldState] toast remove failed:", normalizeErrorMessage(err));
    },
  );
}

// incomingCall is what gets a toast past Focus Assist while a game runs fullscreen,
// so the scenario stays and the dismiss timer below is what ends the toast.
function sendWindowsToast(title: string, body: string): void {
  const tag = `wfc-${++_toastTagCounter}`;
  const xml = `<toast scenario="incomingCall"><visual><binding template="ToastGeneric"><text>${escapeXml(
    title,
  )}</text><text>${escapeXml(body)}</text></binding></visual>${toastAudio()}</toast>`;
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
  _outstandingToastTags.add(tag);
  playNotificationSound();
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
      TOAST_GROUP,
      APP_USER_MODEL_ID,
    ],
    { windowsHide: true, timeout: 8000 },
    (err) => {
      if (err) log.warn("[WorldState] toast error:", normalizeErrorMessage(err));
      fs.unlink(xmlPath, () => {});
      fs.unlink(showScriptPath, () => {});
    },
  );

  const dismissMs = durationMsFromSeconds(
    ctx.overlaySettings?.windowsNotificationSeconds,
    TOAST_DISMISS_MS,
  );

  // Auto-dismiss: remove the toast from the notification center after the
  // banner display time so it doesn't stick around like a phone call.
  setTimeout(() => removeToast(tag), dismissMs);
}

// Keep references to active notifications to prevent GC before display.
const _activeNotifications = new Set<{ close: () => void }>();

// The legacy switch mutes the OS toast only, same as the trade toast; the
// webhook route is dispatch's call, per source.
function sendDesktopNotification(title: string, body: string): void {
  dispatch({ source: "worldState", title, body }, () => {
    if (ctx.overlaySettings.worldNotificationsEnabled === false) return;
    sendDesktopNotificationRaw(title, body, "world");
  });
}

/** Sends a toast. History is recorded before the platform gate, so a caller
 *  that reaches here still leaves an entry on a system that cannot show toasts;
 *  a caller whose own settings gate turned it away never reaches here and
 *  records nothing. */
export function sendDesktopNotificationRaw(
  title: string,
  body: string,
  kind: NotificationKind = "app",
): void {
  recordNotification(kind, title, body);
  try {
    if (!canSendNotifications()) return;
    // A trade body names the other player and main.log is what people attach to
    // a support report, so that kind is logged without its text.
    const shown = kind === "trade" ? "(body withheld)" : body;
    log.info(`[WorldState] sending ${kind} notification:`, title, "-", shown);
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

  const stateRecord = asRecord(state) ?? {};
  const voidTrader = asRecord(stateRecord.voidTrader) ?? {};

  if (!prev.baroActive && next.baroActive) {
    const location = str(voidTrader.location) || "Relay";
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

  type CycleValue = boolean | string | null;
  const transitions: Array<{
    enabled: boolean;
    prevVal: CycleValue;
    nextVal: CycleValue;
    title: string;
    body: (v: boolean | string) => string;
  }> = [
    {
      enabled: !!cycleAlerts.earth,
      prevVal: prev.earthIsDay,
      nextVal: next.earthIsDay,
      title: "Earth Cycle",
      body: (v) => (v ? "Day has begun." : "Night has begun."),
    },
    {
      enabled: !!cycleAlerts.cetus,
      prevVal: prev.cetusIsDay,
      nextVal: next.cetusIsDay,
      title: "Cetus Cycle",
      body: (v) => (v ? "Day has begun." : "Night has begun."),
    },
    {
      enabled: !!cycleAlerts.vallis,
      prevVal: prev.vallisIsWarm,
      nextVal: next.vallisIsWarm,
      title: "Orb Vallis Cycle",
      body: (v) => (v ? "Warm cycle has begun." : "Cold cycle has begun."),
    },
    {
      enabled: !!cycleAlerts.cambion,
      prevVal: prev.cambionActive,
      nextVal: next.cambionActive,
      title: "Cambion Drift Cycle",
      body: (v) => `${v ? String(v).toUpperCase() : "Unknown"} cycle has begun.`,
    },
    {
      enabled: !!cycleAlerts.duviri,
      prevVal: prev.duviriState,
      nextVal: next.duviriState,
      title: "Duviri Cycle",
      body: (v) => `${v ? capitalize(String(v)) : "Unknown"} mood has begun.`,
    },
  ];
  for (const t of transitions) {
    if (t.enabled && t.prevVal !== null && t.nextVal !== null && t.prevVal !== t.nextVal) {
      sendDesktopNotification(t.title, t.body(t.nextVal));
    }
  }

  // Fissure appearance alerts (opt-in per configured alert rules)
  const fissureAlertRules = ctx.overlaySettings?.fissureAlerts;
  if (Array.isArray(fissureAlertRules) && fissureAlertRules.length > 0) {
    const rawFissures = Array.isArray(stateRecord.fissures)
      ? (stateRecord.fissures as unknown[])
      : [];

    for (const f of rawFissures) {
      const fr = asRecord(f);
      if (!fr || fr.expired === true) continue;

      const tier = str(fr.tier) ?? "";
      const node = str(fr.node) ?? "";
      const expiry = str(fr.expiry) ?? "";
      const isHard = fr.isHard === true;
      const fissureId = `${tier}|${node}|${expiry}|${isHard ? "1" : "0"}`;

      // Only notify for newly appeared fissures
      if (prev.fissureIds.has(fissureId)) continue;

      const missionType = str(fr.missionType) ?? "";

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

// Check cached polls for lead-time alerts; transitions remain limited to fresh data.
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
        label: snap.duviriState ? capitalize(snap.duviriState) : "Unknown",
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
      const cycleName = capitalize(c.key);
      sendDesktopNotification(
        `${cycleName} Cycle`,
        `${c.label} in ~${mins} min${mins !== 1 ? "s" : ""}.`,
      );
    }
    // Evict old entries to prevent memory growth
    if (remaining < -300_000) _cyclePreNotified.delete(preKey);
  }
}

function refreshWorldState(): Promise<unknown> {
  if (_worldStateFetch) return _worldStateFetch;

  const request = worldStateParser.fetchAndParse().then((fresh) => {
    _worldStateCache = fresh;
    _worldStateCacheTime = Date.now();
    maybeNotifyWorldEvents(fresh);
    checkPreCycleNotifications(fresh);
    log.info("[WorldState] Fetched and parsed DE world state");
    return fresh;
  });
  _worldStateFetch = request.finally(() => {
    _worldStateFetch = null;
  });
  return _worldStateFetch;
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
  _worldStateFetch = null;
  _worldNotificationSnapshot = null;
  _cyclePreNotified.clear();
  _outstandingToastTags.clear();
  _lastSoundAt = 0;
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

type QuitEmitter = { on?: (event: string, listener: () => void) => void };

function register(
  options: {
    ipcMain?: { handle?: (channel: string, handler: (event: unknown) => Promise<unknown>) => void };
    Notification?: unknown;
    app?: QuitEmitter;
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

  // Settings needs a way to see a notification without waiting for a cycle, a
  // whisper or a trade. It bypasses the per-feature gates, so it exists only
  // where the dev-mode button that calls it does.
  if (!electronModule.app?.isPackaged) {
    ipc.handle(NOTIFICATION_TEST, async (event: unknown) => {
      assertAuthorizedSender(assertMainRendererSender, event as never, NOTIFICATION_TEST);
      sendDesktopNotificationRaw("WFHelper", "Test notification", "app");
      return true;
    });
  }

  ipc.handle(DB_GET_WORLD_STATE, async (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, DB_GET_WORLD_STATE);

    const now = Date.now();
    if (_worldStateCache && now - _worldStateCacheTime < WORLD_STATE_TTL_MS) {
      checkPreCycleNotifications(_worldStateCache);
      return _worldStateCache;
    }

    try {
      return await refreshWorldState();
    } catch (err) {
      const msg = normalizeErrorMessage(err);
      log.error("[WorldState] fetch failed:", msg);
      ctx.mainWindow?.webContents.send(WORLD_STATE_FETCH_ERROR, msg);
      sendToPopouts(WORLD_STATE_FETCH_ERROR, msg);
      if (!_worldStateCache) {
        _worldStateCache = worldStateParser.emptyWorldState();
      }
      return _worldStateCache;
    }
  });
  _registered = true;

  const quitEmitter = options.app ?? (electronModule.app as QuitEmitter | undefined);
  // Not once: quit is deferred and re-fired while the DBWIN worker stops, and a
  // toast raised in that window would otherwise never be pulled. Removing an
  // empty set is a no-op, so the extra call costs nothing.
  if (typeof quitEmitter?.on === "function") {
    quitEmitter.on("before-quit", removeOutstandingToasts);
  }

  // Ensure we have a Start Menu shortcut so Windows recognises us for
  // toast notifications under Focus Assist "Priority only" mode.
  ensureStartMenuShortcut();

  // Seed the world state cache shortly after startup so cycle notifications
  // work immediately, even before the user visits the World tab.
  _startupSeedTimer = setTimeout(async () => {
    _startupSeedTimer = null;
    try {
      await refreshWorldState();
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
      await refreshWorldState();
    } catch (err) {
      log.warn("[WorldState] background refresh failed:", normalizeErrorMessage(err));
    }
  }, 60_000);
}

const __test__ = {
  reset: resetForTest,
  setDesktopNotificationSender: setDesktopNotificationSenderForTest,
  expireCache: expireWorldStateCacheForTest,
};

export { register, __test__ };
