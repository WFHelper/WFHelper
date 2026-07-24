import { normalizeErrorMessage } from "../../config/shared/errors";
import { clampNumber } from "../../config/shared/numeric";
import { asRecord } from "../ipcValidators";
import { LEGACY_INTERACTION_HOTKEY } from "../../config/runtime/overlaySettings";
import type {
  OverlaySavedWindowBounds,
  OverlaySettings,
  OverlayWindowKey,
} from "../../config/runtime/overlaySettings";

/** Internal dict for validation before assigning to typed ctx.overlaySettings. */
type OverlaySettingsDict = Record<string, unknown>;

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type OverlayCtx = {
  overlaySettings: OverlaySettings;
  overlayHotkeyRegistered: string | null;
  overlayWindow: import("electron").BrowserWindow | null;
  plannerOverlayWindow?: import("electron").BrowserWindow | null;
  overlayInteractionHotkeyRegistered: string | null;
  overlayInteractiveMode: boolean;
};

type OverlayFs = Pick<typeof import("node:fs"), "existsSync" | "readFileSync">;

type OverlaySettingsControllerOptions = {
  log: Logger;
  fs: OverlayFs;
  writeFileAtomic: (filePath: string, data: string) => void;
  globalShortcut: typeof import("electron").globalShortcut;
  ctx: OverlayCtx;
  settingsFile: string;
  defaults: OverlaySettingsDict;
  onRelicRewardTrigger: (source?: string) => void;
  onToggleOverlayInteractionMode: (source?: string) => void;
};

function normalizeHotkey(value: unknown, fallbackHotkey: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallbackHotkey;
  if (!raw.includes("+")) return raw.toUpperCase();
  const normalized = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const low = part.toLowerCase();
      if (low === "commandorcontrol") return "CommandOrControl";
      if (low === "command") return "Command";
      if (low === "control" || low === "ctrl") return "Control";
      if (low === "alt") return "Alt";
      if (low === "option") return "Option";
      if (low === "shift") return "Shift";
      if (low === "super") return "Super";
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    })
    .join("+");

  const parts = normalized
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers = new Set([
    "CommandOrControl",
    "Command",
    "Control",
    "Alt",
    "Option",
    "Shift",
    "Super",
  ]);
  const hasNonModifierKey = parts.some((part) => !modifiers.has(part));
  return hasNonModifierKey ? normalized : fallbackHotkey;
}

export function createOverlaySettingsController(options: OverlaySettingsControllerOptions) {
  const {
    log,
    fs,
    writeFileAtomic,
    globalShortcut,
    ctx,
    settingsFile,
    defaults,
    onRelicRewardTrigger,
    onToggleOverlayInteractionMode,
  } = options;

  function normalizeFissureAlerts(
    value: unknown,
    fallback: unknown,
  ): Array<{ id: string; tier: string; missionType: string; steelPath: string; planet: string }> {
    const arr = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
    return arr
      .map(asRecord)
      .filter((r): r is Record<string, unknown> => r !== null)
      .map((r) => {
        return {
          id: typeof r.id === "string" && r.id ? r.id : Math.random().toString(36).slice(2, 10),
          tier: typeof r.tier === "string" ? r.tier : "any",
          missionType: typeof r.missionType === "string" ? r.missionType : "any",
          steelPath:
            r.steelPath === "normal" || r.steelPath === "steel" ? (r.steelPath as string) : "any",
          planet: typeof r.planet === "string" ? r.planet : "any",
        };
      });
  }

  function normalizeCycleAlerts(
    value: unknown,
    fallback: unknown,
  ): { earth: boolean; cetus: boolean; vallis: boolean; cambion: boolean; duviri: boolean } {
    const def = asRecord(fallback) ?? {};
    const v = asRecord(value) ?? {};
    return {
      earth: v.earth !== undefined ? !!v.earth : !!def.earth,
      cetus: v.cetus !== undefined ? !!v.cetus : !!def.cetus,
      vallis: v.vallis !== undefined ? !!v.vallis : !!def.vallis,
      cambion: v.cambion !== undefined ? !!v.cambion : !!def.cambion,
      duviri: v.duviri !== undefined ? !!v.duviri : !!def.duviri,
    };
  }

  function normalizeOverlayScale(value: unknown, fallback: unknown): number {
    return Number(clampNumber(value, 0.75, 1.5, Number(fallback ?? 1)).toFixed(2));
  }

  function normalizeWindowScales(value: unknown): Partial<Record<OverlayWindowKey, number>> {
    const input = asRecord(value);
    if (!input) return {};
    const keys: OverlayWindowKey[] = [
      "reward",
      "planner",
      "rivenLeft",
      "rivenRight",
      "arbiSummary",
    ];
    const out: Partial<Record<OverlayWindowKey, number>> = {};
    for (const key of keys) {
      const scale = clampNumber(input[key], 0.75, 1.5, NaN);
      if (Number.isFinite(scale)) out[key] = Number(scale.toFixed(2));
    }
    return out;
  }

  function normalizeSavedBounds(
    value: unknown,
  ): Partial<Record<OverlayWindowKey, OverlaySavedWindowBounds>> {
    const input = asRecord(value);
    if (!input) return {};
    const keys: OverlayWindowKey[] = [
      "reward",
      "planner",
      "rivenLeft",
      "rivenRight",
      "arbiSummary",
    ];
    const out: Partial<Record<OverlayWindowKey, OverlaySavedWindowBounds>> = {};
    for (const key of keys) {
      const record = asRecord(input[key]);
      if (!record) continue;
      const x = Math.round(clampNumber(record.x, -20000, 20000, NaN));
      const y = Math.round(clampNumber(record.y, -20000, 20000, NaN));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const displayId =
        typeof record.displayId === "string" && record.displayId.trim()
          ? record.displayId.trim()
          : null;
      out[key] = displayId ? { x, y, displayId } : { x, y };
    }
    return out;
  }

  function normalizeOverlaySettings(raw: unknown): OverlaySettingsDict {
    const candidate = asRecord(raw) ?? {};
    const booleanSetting = (key: keyof OverlaySettings): boolean =>
      candidate[key] !== undefined ? !!candidate[key] : !!defaults[key];
    const tradeNotificationOverlayEnabled =
      candidate.tradeNotificationOverlayEnabled !== undefined
        ? !!candidate.tradeNotificationOverlayEnabled
        : candidate.showTradeNotification !== undefined
          ? !!candidate.showTradeNotification
          : !!defaults.tradeNotificationOverlayEnabled;

    return {
      autoTriggerEnabled: booleanSetting("autoTriggerEnabled"),
      hotkeyEnabled: booleanSetting("hotkeyEnabled"),
      hotkey: normalizeHotkey(candidate.hotkey ?? defaults.hotkey, String(defaults.hotkey)),
      interactionHotkeyEnabled: booleanSetting("interactionHotkeyEnabled"),
      // Migrate the retired Control+Tab default (global grab that stole the
      // browser tab-switch key) onto the current default.
      interactionHotkey: normalizeHotkey(
        candidate.interactionHotkey === LEGACY_INTERACTION_HOTKEY
          ? defaults.interactionHotkey
          : (candidate.interactionHotkey ?? defaults.interactionHotkey),
        String(defaults.interactionHotkey),
      ),
      worldNotificationsEnabled: booleanSetting("worldNotificationsEnabled"),
      cycleAlerts: normalizeCycleAlerts(candidate.cycleAlerts, defaults.cycleAlerts),
      cycleAlertMinutesBefore: Math.floor(
        clampNumber(
          candidate.cycleAlertMinutesBefore,
          0,
          120,
          Number((defaults as Record<string, unknown>).cycleAlertMinutesBefore ?? 3),
        ),
      ),
      fissureAlerts: normalizeFissureAlerts(candidate.fissureAlerts, defaults.fissureAlerts),
      notificationSoundEnabled: booleanSetting("notificationSoundEnabled"),
      wfmNotificationsEnabled: booleanSetting("wfmNotificationsEnabled"),
      messageNotificationsEnabled: booleanSetting("messageNotificationsEnabled"),
      messageNotificationsWhileFocused: booleanSetting("messageNotificationsWhileFocused"),
      autoCloseWfmOrders: booleanSetting("autoCloseWfmOrders"),
      relicRewardsOverlayEnabled: booleanSetting("relicRewardsOverlayEnabled"),
      relicRecommendationOverlayEnabled: booleanSetting("relicRecommendationOverlayEnabled"),
      tradeNotificationOverlayEnabled,
      rivenOverlayEnabled: booleanSetting("rivenOverlayEnabled"),
      arbiSummaryOverlayEnabled: booleanSetting("arbiSummaryOverlayEnabled"),
      arbiTrackingEnabled: booleanSetting("arbiTrackingEnabled"),
      ocrDebugImagesEnabled: booleanSetting("ocrDebugImagesEnabled"),
      uiScale: normalizeOverlayScale(candidate.uiScale, defaults.uiScale),
      overlayScale: normalizeOverlayScale(candidate.overlayScale, defaults.overlayScale),
      overlayWindowScales: normalizeWindowScales(candidate.overlayWindowScales),
      overlayWindowBounds: normalizeSavedBounds(candidate.overlayWindowBounds),
      overlayDragHintDismissed: booleanSetting("overlayDragHintDismissed"),
    };
  }

  function loadOverlaySettings(): OverlaySettings {
    try {
      if (fs.existsSync(settingsFile)) {
        const raw = fs.readFileSync(settingsFile, "utf8");
        const parsed = JSON.parse(raw);
        ctx.overlaySettings = normalizeOverlaySettings({
          ...defaults,
          ...parsed,
        }) as OverlaySettings;
      } else {
        ctx.overlaySettings = { ...defaults } as OverlaySettings;
      }
    } catch (err) {
      log.warn(
        "[OverlaySettings] Failed to load settings, using defaults:",
        normalizeErrorMessage(err),
      );
      ctx.overlaySettings = { ...defaults } as OverlaySettings;
    }
    return ctx.overlaySettings;
  }

  function saveOverlaySettings(): boolean {
    try {
      writeFileAtomic(settingsFile, JSON.stringify(ctx.overlaySettings, null, 2));
      return true;
    } catch (err) {
      log.error("[OverlaySettings] Failed to save settings:", normalizeErrorMessage(err));
      return false;
    }
  }

  function unregisterOverlayTriggerHotkey(): void {
    if (!ctx.overlayHotkeyRegistered) return;
    try {
      globalShortcut.unregister(ctx.overlayHotkeyRegistered);
    } catch (err) {
      log.warn("[OverlayHotkey] unregister failed:", normalizeErrorMessage(err));
    }
    ctx.overlayHotkeyRegistered = null;
  }

  function unregisterOverlayInteractionHotkey(): void {
    if (!ctx.overlayInteractionHotkeyRegistered) return;
    try {
      globalShortcut.unregister(ctx.overlayInteractionHotkeyRegistered);
    } catch (err) {
      log.warn("[OverlayInteractionHotkey] unregister failed:", normalizeErrorMessage(err));
    }
    ctx.overlayInteractionHotkeyRegistered = null;
  }

  function unregisterOverlayHotkey(): void {
    unregisterOverlayTriggerHotkey();
    unregisterOverlayInteractionHotkey();
  }

  function registerOverlayTriggerHotkey(): boolean {
    unregisterOverlayTriggerHotkey();

    if (!ctx.overlaySettings.hotkeyEnabled) {
      log.info("[OverlayHotkey] disabled");
      return false;
    }

    const accelerator = String(ctx.overlaySettings.hotkey || "");
    if (!accelerator) return false;

    try {
      const ok = globalShortcut.register(accelerator, () => onRelicRewardTrigger("hotkey"));
      if (!ok) {
        log.warn("[OverlayHotkey] register failed:", accelerator);
        return false;
      }
      ctx.overlayHotkeyRegistered = accelerator;
      log.info("[OverlayHotkey] registered:", accelerator);
      return true;
    } catch (err) {
      log.warn("[OverlayHotkey] invalid shortcut:", accelerator, normalizeErrorMessage(err));
      return false;
    }
  }

  function registerOverlayInteractionHotkey(): boolean {
    unregisterOverlayInteractionHotkey();

    if (!ctx.overlaySettings.interactionHotkeyEnabled) {
      log.info("[OverlayInteractionHotkey] disabled");
      return false;
    }

    const accelerator = String(ctx.overlaySettings.interactionHotkey || "");
    if (!accelerator) return false;

    try {
      const ok = globalShortcut.register(accelerator, () => {
        onToggleOverlayInteractionMode("hotkey");
      });
      if (!ok) {
        log.warn("[OverlayInteractionHotkey] register failed:", accelerator);
        return false;
      }
      ctx.overlayInteractionHotkeyRegistered = accelerator;
      log.info("[OverlayInteractionHotkey] registered:", accelerator);
      return true;
    } catch (err) {
      log.warn(
        "[OverlayInteractionHotkey] invalid shortcut:",
        accelerator,
        normalizeErrorMessage(err),
      );
      return false;
    }
  }

  function registerOverlayHotkey(): boolean {
    const triggerOk = registerOverlayTriggerHotkey();
    const interactionOk = registerOverlayInteractionHotkey();
    return triggerOk || interactionOk;
  }

  function setOverlaySettings(nextSettings: unknown): OverlaySettings {
    ctx.overlaySettings = normalizeOverlaySettings({
      ...ctx.overlaySettings,
      ...(asRecord(nextSettings) ?? {}),
    }) as OverlaySettings;

    saveOverlaySettings();
    return { ...ctx.overlaySettings };
  }

  return {
    normalizeOverlaySettings,
    loadOverlaySettings,
    saveOverlaySettings,
    unregisterOverlayHotkey,
    registerOverlayHotkey,
    setOverlaySettings,
  };
}
