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
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    fs: {
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "{}"),
    },
    writeFileAtomic: vi.fn(),
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

  const controller = createOverlaySettingsController(
    deps as unknown as Parameters<typeof createOverlaySettingsController>[0],
  );
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

  it("migrates the retired Control+Tab interaction default off the global grab", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      interactionHotkey: "Control+Tab",
    });

    expect(normalized.interactionHotkey).toBe(OVERLAY_SETTINGS_DEFAULTS.interactionHotkey);
    expect(normalized.interactionHotkey).not.toBe("Control+Tab");
  });

  it("keeps a deliberately-set interaction hotkey that is not the retired default", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      interactionHotkey: "Control+Shift+Tab",
    });

    expect(normalized.interactionHotkey).toBe("Control+Shift+Tab");
  });

  it("normalizes the full overlay settings schema", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({});

    expect(Object.keys(normalized).sort()).toEqual(Object.keys(OVERLAY_SETTINGS_DEFAULTS).sort());
    expect(normalized.autoCloseWfmOrders).toBe(true);
  });

  it("preserves WFM order automation settings", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      autoCloseWfmOrders: false,
    });

    expect(normalized.autoCloseWfmOrders).toBe(false);
  });

  it("normalizes notification sound and overlay availability settings", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      notificationSoundEnabled: false,
      relicRewardsOverlayEnabled: false,
      relicRecommendationOverlayEnabled: false,
      tradeNotificationOverlayEnabled: false,
      rivenOverlayEnabled: false,
    });

    expect(normalized.notificationSoundEnabled).toBe(false);
    expect(normalized.relicRewardsOverlayEnabled).toBe(false);
    expect(normalized.relicRecommendationOverlayEnabled).toBe(false);
    expect(normalized.tradeNotificationOverlayEnabled).toBe(false);
    expect(normalized.rivenOverlayEnabled).toBe(false);
  });

  it("normalizes overlay sizing and remembered bounds", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      overlayScale: 2,
      overlayWindowBounds: {
        reward: { x: 120, y: 240, displayId: "7" },
        arbiSummary: { x: 15, y: 25 },
        nope: { x: 1, y: 2 },
        planner: { x: "bad", y: 10 },
      },
    });

    expect(normalized.overlayScale).toBe(1.5);
    expect(normalized.overlayWindowBounds).toEqual({
      reward: { x: 120, y: 240, displayId: "7" },
      arbiSummary: { x: 15, y: 25 },
    });
  });

  it("defaults the drag hint to visible and round-trips a dismissal", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({}).overlayDragHintDismissed).toBe(false);
    expect(
      controller.normalizeOverlaySettings({ overlayDragHintDismissed: true })
        .overlayDragHintDismissed,
    ).toBe(true);
  });

  it("migrates the legacy trade notification setting to the overlay toggle", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      showTradeNotification: false,
    });

    expect(normalized.tradeNotificationOverlayEnabled).toBe(false);
  });

  it("persists settings", () => {
    const { controller, deps } = buildController();

    const next = controller.setOverlaySettings({
      hotkey: "alt + p",
      worldNotificationsEnabled: false,
    });

    expect(next.hotkey).toBe("Alt+P");
    expect(next.worldNotificationsEnabled).toBe(false);
    expect(deps.writeFileAtomic).toHaveBeenCalledTimes(1);
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
