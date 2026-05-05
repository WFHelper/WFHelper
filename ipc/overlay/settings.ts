import { normalizeErrorMessage } from "../../config/shared/errors";
import { clampNumber } from "../../config/shared/numeric";
import type { OverlaySettings } from "../../config/runtime/overlaySettings";

/** Internal dict for validation before assigning to typed ctx.overlaySettings. */
type OverlaySettingsDict = Record<string, unknown>;

type Logger = {
  log: (...args: unknown[]) => void;
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

type OverlayFs = Pick<typeof import("node:fs"), "existsSync" | "readFileSync" | "writeFileSync">;

type OverlaySettingsControllerOptions = {
  log: Logger;
  fs: OverlayFs;
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
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const r = item as Record<string, unknown>;
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
    const def =
      fallback && typeof fallback === "object" ? (fallback as Record<string, unknown>) : {};
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      earth: v.earth !== undefined ? !!v.earth : !!def.earth,
      cetus: v.cetus !== undefined ? !!v.cetus : !!def.cetus,
      vallis: v.vallis !== undefined ? !!v.vallis : !!def.vallis,
      cambion: v.cambion !== undefined ? !!v.cambion : !!def.cambion,
      duviri: v.duviri !== undefined ? !!v.duviri : !!def.duviri,
    };
  }

  function normalizeOverlaySettings(raw: unknown): OverlaySettingsDict {
    const candidate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
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
      interactionHotkey: normalizeHotkey(
        candidate.interactionHotkey ?? defaults.interactionHotkey,
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
      autoCloseWfmOrders: booleanSetting("autoCloseWfmOrders"),
      showTradeNotification:
        candidate.showTradeNotification !== undefined
          ? !!candidate.showTradeNotification
          : tradeNotificationOverlayEnabled,
      relicRewardsOverlayEnabled: booleanSetting("relicRewardsOverlayEnabled"),
      relicRecommendationOverlayEnabled: booleanSetting("relicRecommendationOverlayEnabled"),
      tradeNotificationOverlayEnabled,
      rivenOverlayEnabled: booleanSetting("rivenOverlayEnabled"),
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
      fs.writeFileSync(settingsFile, JSON.stringify(ctx.overlaySettings, null, 2), "utf8");
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
      log.log("[OverlayHotkey] disabled");
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
      log.log("[OverlayHotkey] registered:", accelerator);
      return true;
    } catch (err) {
      log.warn("[OverlayHotkey] invalid shortcut:", accelerator, normalizeErrorMessage(err));
      return false;
    }
  }

  function registerOverlayInteractionHotkey(): boolean {
    unregisterOverlayInteractionHotkey();

    if (!ctx.overlaySettings.interactionHotkeyEnabled) {
      log.log("[OverlayInteractionHotkey] disabled");
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
      log.log("[OverlayInteractionHotkey] registered:", accelerator);
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
      ...(nextSettings && typeof nextSettings === "object"
        ? (nextSettings as Record<string, unknown>)
        : {}),
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
