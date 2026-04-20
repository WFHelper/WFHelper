import { describe, expect, it, vi } from "vitest";

import { createOverlaySettingsController } from "../../ipc/overlay/settings";

function buildController() {
  const ctx = {
    overlaySettings: {
      autoTriggerEnabled: true,
      hotkeyEnabled: true,
      hotkey: "Control+Alt+R",
      ocrEngine: "native",
      ocrPasses: 3,
      matchThreshold: 0.72,
      ocrTimeoutMs: 1800,
      worldNotificationsEnabled: true,
    },
    overlayHotkeyRegistered: null,
    overlayInteractionHotkeyRegistered: null,
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
      ocrEngine: "native",
      ocrPasses: 3,
      matchThreshold: 0.72,
      ocrTimeoutMs: 1800,
      worldNotificationsEnabled: true,
    },
    limits: {
      ocrPassesMin: 1,
      ocrPassesMax: 6,
      matchThresholdMin: 0.4,
      matchThresholdMax: 0.95,
      ocrTimeoutMsMin: 400,
      ocrTimeoutMsMax: 6000,
    },
    ocrEngines: ["windows"],
    rewardScanner: {
      setSettings: vi.fn(),
    },
    onRelicRewardTrigger: vi.fn(),
  };

  const controller = createOverlaySettingsController(deps);
  return { controller, deps, ctx, registerCallbacks };
}

describe("overlay settings controller", () => {
  it("normalizes hotkeys and clamps settings values", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      hotkey: "ctrl + k",
      ocrEngine: "invalid",
      ocrPasses: 999,
      matchThreshold: 0.1,
      ocrTimeoutMs: 10,
    });

    expect(normalized.hotkey).toBe("Control+K");
    expect(normalized.ocrEngine).toBe("native");
    expect(normalized.ocrPasses).toBe(6);
    expect(normalized.matchThreshold).toBe(0.4);
    expect(normalized.ocrTimeoutMs).toBe(400);
  });

  it("persists settings and updates scanner state", () => {
    const { controller, deps } = buildController();

    const next = controller.setOverlaySettings({
      hotkey: "alt + p",
      worldNotificationsEnabled: false,
    });

    expect(next.hotkey).toBe("Alt+P");
    expect(next.worldNotificationsEnabled).toBe(false);
    expect(deps.rewardScanner.setSettings).toHaveBeenCalledWith(next);
    expect(deps.fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("registers hotkeys and dispatches trigger callbacks", () => {
    const { controller, deps, registerCallbacks } = buildController();
    controller.registerOverlayHotkey();

    expect(deps.globalShortcut.register).toHaveBeenCalledWith(
      "Control+Alt+R",
      expect.any(Function),
    );

    registerCallbacks.get("Control+Alt+R")?.();
    expect(deps.onRelicRewardTrigger).toHaveBeenCalledWith("hotkey");
  });
});
