import { describe, expect, it, vi } from "vitest";

const { createOverlaySettingsController } = require("../../ipc/overlay/settings.js");

function buildController() {
  const ctx = {
    overlaySettings: {
      autoTriggerEnabled: true,
      hotkeyEnabled: true,
      hotkey: "Control+Alt+R",
      cropDebugHotkeyEnabled: true,
      cropDebugHotkey: "Control+Alt+D",
      cropPreset: "middle",
      cropTopRatio: 0.4,
      cropHeightRatio: 0.34,
      ocrEngine: "native",
      ocrPasses: 3,
      matchThreshold: 0.72,
      ocrTimeoutMs: 1800,
      worldNotificationsEnabled: true,
    },
    overlayHotkeyRegistered: null,
    overlayCropHotkeyRegistered: null,
    cropDebugWindow: null,
  };

  const registerCallbacks = new Map<string, () => void>();

  const deps = {
    log: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    fs: {
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "{}"),
      writeFileSync: vi.fn(),
    },
    globalShortcut: {
      register: vi.fn((accelerator: string, handler: () => void) => {
        registerCallbacks.set(accelerator, handler);
        return true;
      }),
      unregister: vi.fn((accelerator: string) => {
        registerCallbacks.delete(accelerator);
      }),
    },
    ctx,
    settingsFile: "D:/tmp/overlay-settings.json",
    defaults: {
      autoTriggerEnabled: true,
      hotkeyEnabled: true,
      hotkey: "Control+Alt+R",
      cropDebugHotkeyEnabled: true,
      cropDebugHotkey: "Control+Alt+D",
      cropPreset: "middle",
      cropTopRatio: 0.4,
      cropHeightRatio: 0.34,
      ocrEngine: "native",
      ocrPasses: 3,
      matchThreshold: 0.72,
      ocrTimeoutMs: 1800,
      worldNotificationsEnabled: true,
    },
    limits: {
      cropTopRatioMin: 0.05,
      cropTopRatioMax: 0.9,
      cropHeightRatioMin: 0.08,
      cropHeightRatioMax: 0.95,
      ocrPassesMin: 1,
      ocrPassesMax: 6,
      matchThresholdMin: 0.4,
      matchThresholdMax: 0.95,
      ocrTimeoutMsMin: 400,
      ocrTimeoutMsMax: 6000,
    },
    cropPresets: ["top", "middle", "bottom", "custom"],
    ocrEngines: ["native", "tesseract"],
    rewardScanner: {
      setSettings: vi.fn(),
    },
    onRelicRewardTrigger: vi.fn(),
    onOpenCropDebugger: vi.fn(async () => ({ ok: true })),
  };

  const controller = createOverlaySettingsController(deps);
  return { controller, deps, ctx, registerCallbacks };
}

describe("overlay settings controller", () => {
  it("normalizes hotkeys and clamps crop/settings values", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      hotkey: "ctrl + k",
      cropDebugHotkey: "shift + f8",
      cropPreset: "invalid",
      cropTopRatio: 0.93,
      cropHeightRatio: 0.5,
      ocrEngine: "invalid",
      ocrPasses: 999,
      matchThreshold: 0.1,
      ocrTimeoutMs: 10,
    });

    expect(normalized.hotkey).toBe("Control+K");
    expect(normalized.cropDebugHotkey).toBe("Shift+F8");
    expect(normalized.cropPreset).toBe("middle");
    expect(normalized.cropTopRatio).toBeLessThanOrEqual(0.9);
    expect(normalized.cropTopRatio + normalized.cropHeightRatio).toBeLessThanOrEqual(1);
    expect(normalized.ocrEngine).toBe("native");
    expect(normalized.ocrPasses).toBe(6);
    expect(normalized.matchThreshold).toBe(0.4);
    expect(normalized.ocrTimeoutMs).toBe(400);
  });

  it("persists settings and updates scanner state", () => {
    const { controller, deps } = buildController();

    const next = controller.setOverlaySettings({
      hotkey: "alt + p",
      cropPreset: "top",
      worldNotificationsEnabled: false,
    });

    expect(next.hotkey).toBe("Alt+P");
    expect(next.cropPreset).toBe("top");
    expect(next.worldNotificationsEnabled).toBe(false);
    expect(deps.rewardScanner.setSettings).toHaveBeenCalledWith(next);
    expect(deps.fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("registers hotkeys and dispatches trigger callbacks", async () => {
    const { controller, deps, registerCallbacks } = buildController();
    controller.registerOverlayHotkey();

    expect(deps.globalShortcut.register).toHaveBeenCalledWith(
      "Control+Alt+R",
      expect.any(Function),
    );
    expect(deps.globalShortcut.register).toHaveBeenCalledWith(
      "Control+Alt+D",
      expect.any(Function),
    );

    registerCallbacks.get("Control+Alt+R")?.();
    expect(deps.onRelicRewardTrigger).toHaveBeenCalledWith("hotkey");

    await registerCallbacks.get("Control+Alt+D")?.();
    expect(deps.onOpenCropDebugger).toHaveBeenCalledWith("hotkey");
  });
});
