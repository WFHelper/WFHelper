import { describe, expect, it, vi } from "vitest";

import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings";
import { createOverlaySettingsController } from "../../ipc/overlay/settings";

function buildController() {
  const ctx = {
    overlaySettings: { ...OVERLAY_SETTINGS_DEFAULTS, hotkey: "Control+Alt+R" },
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
      ...OVERLAY_SETTINGS_DEFAULTS,
      hotkey: "Control+Alt+R",
    },
    onRelicRewardTrigger: vi.fn(),
    onToggleOverlayInteractionMode: vi.fn(),
  };

  const controller = createOverlaySettingsController(deps);
  return { controller, deps, ctx, registerCallbacks };
}

describe("overlay settings controller", () => {
  it("normalizes hotkeys", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      hotkey: "ctrl + k",
    });

    expect(normalized.hotkey).toBe("Control+K");
  });

  it("normalizes the full overlay settings schema", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({});

    expect(Object.keys(normalized).sort()).toEqual(Object.keys(OVERLAY_SETTINGS_DEFAULTS).sort());
  });

  it("preserves WFM order automation settings", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      autoCloseWfmOrders: false,
      showTradeNotification: false,
    });

    expect(normalized.autoCloseWfmOrders).toBe(false);
    expect(normalized.showTradeNotification).toBe(false);
  });

  it("persists settings", () => {
    const { controller, deps } = buildController();

    const next = controller.setOverlaySettings({
      hotkey: "alt + p",
      worldNotificationsEnabled: false,
    });

    expect(next.hotkey).toBe("Alt+P");
    expect(next.worldNotificationsEnabled).toBe(false);
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
