"use strict";

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeHotkey(value, fallbackHotkey) {
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

function createOverlaySettingsController(options) {
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

  function normalizeOcrEngine(value) {
    const engine = typeof value === "string" ? value.trim().toLowerCase() : "";
    return ocrEngines.includes(engine) ? engine : defaults.ocrEngine;
  }

  function normalizeCropRatios(topInput, heightInput) {
    const minTop = limits.cropTopRatioMin;
    const maxTop = limits.cropTopRatioMax;
    const minHeight = limits.cropHeightRatioMin;
    const maxHeight = limits.cropHeightRatioMax;

    let top = clampNumber(topInput, minTop, maxTop, defaults.cropTopRatio);
    let height = clampNumber(heightInput, minHeight, maxHeight, defaults.cropHeightRatio);

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

  function normalizeOverlaySettings(raw) {
    const candidate = raw && typeof raw === "object" ? raw : {};
    const cropPreset =
      typeof candidate.cropPreset === "string" ? candidate.cropPreset.trim().toLowerCase() : "";
    const validCropPreset = cropPresets.includes(cropPreset) ? cropPreset : defaults.cropPreset;

    const cropRatios = normalizeCropRatios(candidate.cropTopRatio, candidate.cropHeightRatio);

    return {
      autoTriggerEnabled:
        candidate.autoTriggerEnabled !== undefined
          ? !!candidate.autoTriggerEnabled
          : defaults.autoTriggerEnabled,
      hotkeyEnabled:
        candidate.hotkeyEnabled !== undefined ? !!candidate.hotkeyEnabled : defaults.hotkeyEnabled,
      hotkey: normalizeHotkey(candidate.hotkey ?? defaults.hotkey, defaults.hotkey),
      cropDebugHotkeyEnabled:
        candidate.cropDebugHotkeyEnabled !== undefined
          ? !!candidate.cropDebugHotkeyEnabled
          : defaults.cropDebugHotkeyEnabled,
      cropDebugHotkey: normalizeHotkey(
        candidate.cropDebugHotkey ?? defaults.cropDebugHotkey,
        defaults.cropDebugHotkey,
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
          defaults.ocrPasses,
        ),
      ),
      matchThreshold: clampNumber(
        candidate.matchThreshold,
        limits.matchThresholdMin,
        limits.matchThresholdMax,
        defaults.matchThreshold,
      ),
      ocrTimeoutMs: Math.floor(
        clampNumber(
          candidate.ocrTimeoutMs,
          limits.ocrTimeoutMsMin,
          limits.ocrTimeoutMsMax,
          defaults.ocrTimeoutMs,
        ),
      ),
      worldNotificationsEnabled:
        candidate.worldNotificationsEnabled !== undefined
          ? !!candidate.worldNotificationsEnabled
          : defaults.worldNotificationsEnabled,
    };
  }

  function loadOverlaySettings() {
    try {
      if (fs.existsSync(settingsFile)) {
        const raw = fs.readFileSync(settingsFile, "utf8");
        const parsed = JSON.parse(raw);
        ctx.overlaySettings = normalizeOverlaySettings({ ...defaults, ...parsed });
      } else {
        ctx.overlaySettings = { ...defaults };
      }
    } catch (err) {
      log.warn("[OverlaySettings] Failed to load settings, using defaults:", err.message);
      ctx.overlaySettings = { ...defaults };
    }
    rewardScanner.setSettings(ctx.overlaySettings);
    return ctx.overlaySettings;
  }

  function saveOverlaySettings() {
    try {
      fs.writeFileSync(settingsFile, JSON.stringify(ctx.overlaySettings, null, 2), "utf8");
      return true;
    } catch (err) {
      log.error("[OverlaySettings] Failed to save settings:", err.message);
      return false;
    }
  }

  function unregisterOverlayTriggerHotkey() {
    if (!ctx.overlayHotkeyRegistered) return;
    try {
      globalShortcut.unregister(ctx.overlayHotkeyRegistered);
    } catch (err) {
      log.warn("[OverlayHotkey] unregister failed:", err.message);
    }
    ctx.overlayHotkeyRegistered = null;
  }

  function unregisterCropDebugHotkey() {
    if (!ctx.overlayCropHotkeyRegistered) return;
    try {
      globalShortcut.unregister(ctx.overlayCropHotkeyRegistered);
    } catch (err) {
      log.warn("[CropHotkey] unregister failed:", err.message);
    }
    ctx.overlayCropHotkeyRegistered = null;
  }

  function unregisterOverlayHotkey() {
    unregisterOverlayTriggerHotkey();
    unregisterCropDebugHotkey();
  }

  function registerOverlayTriggerHotkey() {
    unregisterOverlayTriggerHotkey();

    if (!ctx.overlaySettings.hotkeyEnabled) {
      log.log("[OverlayHotkey] disabled");
      return false;
    }

    const accelerator = ctx.overlaySettings.hotkey;
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
      log.warn("[OverlayHotkey] invalid shortcut:", accelerator, err.message);
      return false;
    }
  }

  function registerCropDebugHotkey() {
    unregisterCropDebugHotkey();

    if (!ctx.overlaySettings.cropDebugHotkeyEnabled) {
      log.log("[CropHotkey] disabled");
      return false;
    }

    const accelerator = ctx.overlaySettings.cropDebugHotkey;
    if (!accelerator) return false;

    try {
      const ok = globalShortcut.register(accelerator, () => {
        void onOpenCropDebugger("hotkey").catch((err) => {
          log.error("[CropHotkey] open debug failed:", err.message);
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
      log.warn("[CropHotkey] invalid shortcut:", accelerator, err.message);
      return false;
    }
  }

  function registerOverlayHotkey() {
    const triggerOk = registerOverlayTriggerHotkey();
    const cropOk = registerCropDebugHotkey();
    return triggerOk || cropOk;
  }

  function setOverlaySettings(nextSettings) {
    ctx.overlaySettings = normalizeOverlaySettings({
      ...ctx.overlaySettings,
      ...(nextSettings && typeof nextSettings === "object" ? nextSettings : {}),
    });

    rewardScanner.setSettings(ctx.overlaySettings);
    saveOverlaySettings();
    return { ...ctx.overlaySettings };
  }

  function applyCropSelection(selection) {
    const cropTopRatio =
      selection && typeof selection === "object" ? selection.cropTopRatio : undefined;
    const cropHeightRatio =
      selection && typeof selection === "object" ? selection.cropHeightRatio : undefined;
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
