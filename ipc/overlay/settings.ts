"use strict";

export {};

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
  overlayCropHotkeyRegistered: string | null;
  cropDebugWindow: import("electron").BrowserWindow | null;
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
  cropPresets: string[];
  ocrEngines: string[];
  rewardScanner: { setSettings: (settings: OverlaySettingsDict) => unknown };
  onRelicRewardTrigger: (source?: string) => void;
  onOpenCropDebugger: (source?: string) => Promise<unknown>;
};

function normalizeHotkey(value: unknown, fallbackHotkey: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallbackHotkey;
  if (!raw.includes("+")) return raw.toUpperCase();
  return raw
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
    cropPresets,
    ocrEngines,
    rewardScanner,
    onRelicRewardTrigger,
    onOpenCropDebugger,
  } = options;

  function normalizeOcrEngine(value: unknown): string {
    const engine = typeof value === "string" ? value.trim().toLowerCase() : "";
    return ocrEngines.includes(engine) ? engine : String(defaults.ocrEngine);
  }

  function normalizeCropRatios(topInput: unknown, heightInput: unknown) {
    const minTop = limits.cropTopRatioMin;
    const maxTop = limits.cropTopRatioMax;
    const minHeight = limits.cropHeightRatioMin;
    const maxHeight = limits.cropHeightRatioMax;

    let top = clampNumber(topInput, minTop, maxTop, Number(defaults.cropTopRatio));
    let height = clampNumber(heightInput, minHeight, maxHeight, Number(defaults.cropHeightRatio));

    if (top + height > 1.0) {
      height = Math.max(minHeight, 1.0 - top);
    }
    if (top + height > 1.0) {
      top = Math.max(minTop, 1.0 - height);
    }

    return {
      top: Number(top.toFixed(4)),
      height: Number(height.toFixed(4)),
    };
  }

  function normalizeOverlaySettings(raw: unknown): OverlaySettingsDict {
    const candidate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const cropPreset =
      typeof candidate.cropPreset === "string" ? candidate.cropPreset.trim().toLowerCase() : "";
    const validCropPreset = cropPresets.includes(cropPreset)
      ? cropPreset
      : String(defaults.cropPreset);

    const cropRatios = normalizeCropRatios(candidate.cropTopRatio, candidate.cropHeightRatio);

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
      cropDebugHotkeyEnabled:
        candidate.cropDebugHotkeyEnabled !== undefined
          ? !!candidate.cropDebugHotkeyEnabled
          : !!defaults.cropDebugHotkeyEnabled,
      cropDebugHotkey: normalizeHotkey(
        candidate.cropDebugHotkey ?? defaults.cropDebugHotkey,
        String(defaults.cropDebugHotkey),
      ),
      cropPreset: validCropPreset,
      cropTopRatio: cropRatios.top,
      cropHeightRatio: cropRatios.height,
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

  function unregisterCropDebugHotkey(): void {
    if (!ctx.overlayCropHotkeyRegistered) return;
    try {
      globalShortcut.unregister(ctx.overlayCropHotkeyRegistered);
    } catch (err) {
      log.warn("[CropHotkey] unregister failed:", normalizeErrorMessage(err));
    }
    ctx.overlayCropHotkeyRegistered = null;
  }

  function unregisterOverlayHotkey(): void {
    unregisterOverlayTriggerHotkey();
    unregisterCropDebugHotkey();
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

  function registerCropDebugHotkey(): boolean {
    unregisterCropDebugHotkey();

    if (!ctx.overlaySettings.cropDebugHotkeyEnabled) {
      log.log("[CropHotkey] disabled");
      return false;
    }

    const accelerator = String(ctx.overlaySettings.cropDebugHotkey || "");
    if (!accelerator) return false;

    try {
      const ok = globalShortcut.register(accelerator, () => {
        void onOpenCropDebugger("hotkey").catch((err) => {
          log.error("[CropHotkey] open debug failed:", normalizeErrorMessage(err));
        });
      });

      if (!ok) {
        log.warn("[CropHotkey] register failed:", accelerator);
        return false;
      }

      ctx.overlayCropHotkeyRegistered = accelerator;
      log.log("[CropHotkey] registered:", accelerator);
      return true;
    } catch (err) {
      log.warn("[CropHotkey] invalid shortcut:", accelerator, normalizeErrorMessage(err));
      return false;
    }
  }

  function registerOverlayHotkey(): boolean {
    const triggerOk = registerOverlayTriggerHotkey();
    const cropOk = registerCropDebugHotkey();
    return triggerOk || cropOk;
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

  function applyCropSelection(selection: unknown): OverlaySettingsDict {
    const cropTopRatio =
      selection && typeof selection === "object"
        ? (selection as Record<string, unknown>).cropTopRatio
        : undefined;
    const cropHeightRatio =
      selection && typeof selection === "object"
        ? (selection as Record<string, unknown>).cropHeightRatio
        : undefined;
    const crop = normalizeCropRatios(cropTopRatio, cropHeightRatio);

    ctx.overlaySettings = normalizeOverlaySettings({
      ...ctx.overlaySettings,
      cropPreset: "custom",
      cropTopRatio: crop.top,
      cropHeightRatio: crop.height,
    });

    rewardScanner.setSettings(ctx.overlaySettings);
    saveOverlaySettings();

    if (ctx.cropDebugWindow && !ctx.cropDebugWindow.isDestroyed()) {
      ctx.cropDebugWindow.webContents.send("crop-debug:applied", {
        cropTopRatio: ctx.overlaySettings.cropTopRatio,
        cropHeightRatio: ctx.overlaySettings.cropHeightRatio,
      });
    }

    return { ...ctx.overlaySettings };
  }

  return {
    normalizeOverlaySettings,
    normalizeCropRatios,
    loadOverlaySettings,
    saveOverlaySettings,
    unregisterOverlayHotkey,
    registerOverlayHotkey,
    setOverlaySettings,
    applyCropSelection,
  };
}

module.exports = {
  createOverlaySettingsController,
};
