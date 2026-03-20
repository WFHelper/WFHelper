
import { createRuntimeRequire } from "../runtimeRequire";

const requireRuntime = createRuntimeRequire(__dirname, 2);
const { normalizeErrorMessage } = requireRuntime<{
  normalizeErrorMessage: (err: unknown, fallback?: string) => string;
}>("config/shared/errors.cjs");
const { clampNumber } = requireRuntime<{
  clampNumber: (value: unknown, min: number, max: number, fallback: number) => number;
}>("config/shared/numeric.cjs");

type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Overlay settings dictionary — values are primitive but stored as unknown for compatibility. */
type OverlaySettingsDict = Record<string, unknown>;

type OverlayCtx = {
  overlaySettings: Record<string, unknown>;
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
  limits: Record<string, number>;
  ocrEngines: string[];
  rewardScanner: { setSettings: (settings: OverlaySettingsDict) => unknown };
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
    limits,
    ocrEngines,
    rewardScanner,
    onRelicRewardTrigger,
    onToggleOverlayInteractionMode,
  } = options;

  function normalizeFissureAlerts(
    value: unknown,
    fallback: unknown,
  ): Array<{ id: string; tier: string; missionType: string; steelPath: string }> {
    const arr = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
    return arr
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const r = item as Record<string, unknown>;
        return {
          id:
            typeof r.id === "string" && r.id
              ? r.id
              : Math.random().toString(36).slice(2, 10),
          tier: typeof r.tier === "string" ? r.tier : "any",
          missionType: typeof r.missionType === "string" ? r.missionType : "any",
          steelPath:
            r.steelPath === "normal" || r.steelPath === "steel"
              ? (r.steelPath as string)
              : "any",
        };
      });
  }

  function normalizeCycleAlerts(
    value: unknown,
    fallback: unknown,
  ): { earth: boolean; cetus: boolean; vallis: boolean; cambion: boolean } {
    const def =
      fallback && typeof fallback === "object" ? (fallback as Record<string, unknown>) : {};
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      earth: v.earth !== undefined ? !!v.earth : !!def.earth,
      cetus: v.cetus !== undefined ? !!v.cetus : !!def.cetus,
      vallis: v.vallis !== undefined ? !!v.vallis : !!def.vallis,
      cambion: v.cambion !== undefined ? !!v.cambion : !!def.cambion,
    };
  }

  function normalizeOcrEngine(value: unknown): string {
    const engine = typeof value === "string" ? value.trim().toLowerCase() : "";
    return ocrEngines.includes(engine) ? engine : String(defaults.ocrEngine);
  }

  function normalizeOverlaySettings(raw: unknown): OverlaySettingsDict {
    const candidate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

    return {
      autoTriggerEnabled:
        candidate.autoTriggerEnabled !== undefined
          ? !!candidate.autoTriggerEnabled
          : !!defaults.autoTriggerEnabled,
      hotkeyEnabled:
        candidate.hotkeyEnabled !== undefined
          ? !!candidate.hotkeyEnabled
          : !!defaults.hotkeyEnabled,
      hotkey: normalizeHotkey(candidate.hotkey ?? defaults.hotkey, String(defaults.hotkey)),
      interactionHotkeyEnabled:
        candidate.interactionHotkeyEnabled !== undefined
          ? !!candidate.interactionHotkeyEnabled
          : !!defaults.interactionHotkeyEnabled,
      interactionHotkey: normalizeHotkey(
        candidate.interactionHotkey ?? defaults.interactionHotkey,
        String(defaults.interactionHotkey),
      ),
      ocrEngine: normalizeOcrEngine(candidate.ocrEngine),
      ocrPasses: Math.floor(
        clampNumber(
          candidate.ocrPasses,
          limits.ocrPassesMin,
          limits.ocrPassesMax,
          Number(defaults.ocrPasses),
        ),
      ),
      matchThreshold: clampNumber(
        candidate.matchThreshold,
        limits.matchThresholdMin,
        limits.matchThresholdMax,
        Number(defaults.matchThreshold),
      ),
      ocrTimeoutMs: Math.floor(
        clampNumber(
          candidate.ocrTimeoutMs,
          limits.ocrTimeoutMsMin,
          limits.ocrTimeoutMsMax,
          Number(defaults.ocrTimeoutMs),
        ),
      ),
      worldNotificationsEnabled:
        candidate.worldNotificationsEnabled !== undefined
          ? !!candidate.worldNotificationsEnabled
          : !!defaults.worldNotificationsEnabled,
      cycleAlerts: normalizeCycleAlerts(candidate.cycleAlerts, defaults.cycleAlerts),
      fissureAlerts: normalizeFissureAlerts(candidate.fissureAlerts, defaults.fissureAlerts),
      wfmNotificationsEnabled:
        candidate.wfmNotificationsEnabled !== undefined
          ? !!candidate.wfmNotificationsEnabled
          : !!defaults.wfmNotificationsEnabled,
    };
  }

  function loadOverlaySettings(): OverlaySettingsDict {
    try {
      if (fs.existsSync(settingsFile)) {
        const raw = fs.readFileSync(settingsFile, "utf8");
        const parsed = JSON.parse(raw);
        ctx.overlaySettings = normalizeOverlaySettings({ ...defaults, ...parsed });
      } else {
        ctx.overlaySettings = { ...defaults };
      }
    } catch (err) {
      log.warn(
        "[OverlaySettings] Failed to load settings, using defaults:",
        normalizeErrorMessage(err),
      );
      ctx.overlaySettings = { ...defaults };
    }
    rewardScanner.setSettings(ctx.overlaySettings);
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

  function setOverlaySettings(nextSettings: unknown): OverlaySettingsDict {
    ctx.overlaySettings = normalizeOverlaySettings({
      ...ctx.overlaySettings,
      ...(nextSettings && typeof nextSettings === "object"
        ? (nextSettings as Record<string, unknown>)
        : {}),
    });

    rewardScanner.setSettings(ctx.overlaySettings);
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
