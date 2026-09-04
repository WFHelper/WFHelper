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

  it("keeps WFM presence automation off by default and snaps the hold duration", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({}).wfmAutoIngameEnabled).toBe(false);
    expect(controller.normalizeOverlaySettings({}).wfmStatusHoldMinutes).toBe(0);
    expect(
      controller.normalizeOverlaySettings({ wfmStatusHoldMinutes: 120 }).wfmStatusHoldMinutes,
    ).toBe(120);
    // Anything outside the offered durations falls back instead of holding forever.
    expect(
      controller.normalizeOverlaySettings({ wfmStatusHoldMinutes: 999 }).wfmStatusHoldMinutes,
    ).toBe(0);
  });

  it("keeps the away rules off by default and clamps the idle delay to 1-60 minutes", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({}).wfmAwayIdleEnabled).toBe(false);
    expect(controller.normalizeOverlaySettings({}).wfmAwayWhenClosedEnabled).toBe(false);
    expect(controller.normalizeOverlaySettings({}).wfmAwayIdleMinutes).toBe(10);
    expect(controller.normalizeOverlaySettings({ wfmAwayIdleMinutes: 25 }).wfmAwayIdleMinutes).toBe(
      25,
    );
    expect(controller.normalizeOverlaySettings({ wfmAwayIdleMinutes: 0 }).wfmAwayIdleMinutes).toBe(
      1,
    );
    expect(
      controller.normalizeOverlaySettings({ wfmAwayIdleMinutes: 999 }).wfmAwayIdleMinutes,
    ).toBe(60);
    // An emptied number input arrives as null and must reach the default.
    expect(
      controller.normalizeOverlaySettings({ wfmAwayIdleMinutes: null }).wfmAwayIdleMinutes,
    ).toBe(10);
  });

  it("clamps the trade notification duration to a usable range", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({}).tradeNotificationSeconds).toBe(5);
    expect(
      controller.normalizeOverlaySettings({ tradeNotificationSeconds: 20 })
        .tradeNotificationSeconds,
    ).toBe(20);
    expect(
      controller.normalizeOverlaySettings({ tradeNotificationSeconds: 0 }).tradeNotificationSeconds,
    ).toBe(2);
    expect(
      controller.normalizeOverlaySettings({ tradeNotificationSeconds: 999 })
        .tradeNotificationSeconds,
    ).toBe(60);
    expect(
      controller.normalizeOverlaySettings({ tradeNotificationSeconds: "12" })
        .tradeNotificationSeconds,
    ).toBe(12);
  });

  it("clamps the Windows notification duration to the same range", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({}).windowsNotificationSeconds).toBe(5);
    expect(
      controller.normalizeOverlaySettings({ windowsNotificationSeconds: 0 })
        .windowsNotificationSeconds,
    ).toBe(2);
    expect(
      controller.normalizeOverlaySettings({ windowsNotificationSeconds: 999 })
        .windowsNotificationSeconds,
    ).toBe(60);
  });

  it("keeps the trade desktop notification opt-in off unless it is set", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({}).tradeDesktopNotificationsEnabled).toBe(false);
    expect(
      controller.normalizeOverlaySettings({ tradeDesktopNotificationsEnabled: true })
        .tradeDesktopNotificationsEnabled,
    ).toBe(true);
    expect(
      controller.normalizeOverlaySettings({ tradeDesktopNotificationsEnabled: false })
        .tradeDesktopNotificationsEnabled,
    ).toBe(false);
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

  it("bounds the configured Warframe interface scale", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({ warframeUiScale: 0.75 }).warframeUiScale).toBe(
      0.75,
    );
    expect(controller.normalizeOverlaySettings({ warframeUiScale: 0.1 }).warframeUiScale).toBe(0.5);
    expect(controller.normalizeOverlaySettings({ warframeUiScale: 2 }).warframeUiScale).toBe(1);
  });

  it("defaults the drag hint to visible and round-trips a dismissal", () => {
    const { controller } = buildController();

    expect(controller.normalizeOverlaySettings({}).overlayDragHintDismissed).toBe(false);
    expect(
      controller.normalizeOverlaySettings({ overlayDragHintDismissed: true })
        .overlayDragHintDismissed,
    ).toBe(true);
  });

  it("keeps tray mode and the injection guard at their opposite defaults", () => {
    const { controller } = buildController();

    // An existing install must keep quitting on close until it opts in.
    expect(controller.normalizeOverlaySettings({}).keepRunningOnClose).toBe(false);
    expect(
      controller.normalizeOverlaySettings({ keepRunningOnClose: true }).keepRunningOnClose,
    ).toBe(true);
    expect(controller.normalizeOverlaySettings({}).blockThirdPartyInjection).toBe(true);
    expect(
      controller.normalizeOverlaySettings({ blockThirdPartyInjection: false })
        .blockThirdPartyInjection,
    ).toBe(false);
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
    controller.setHotkeysActive(true);

    expect(deps.globalShortcut.register).toHaveBeenCalledWith(
      "Control+Alt+R",
      expect.any(Function),
    );

    registerCallbacks.get("Control+Alt+R")?.();
    expect(deps.onRelicRewardTrigger).toHaveBeenCalledWith("hotkey");
  });

  it("holds no global shortcut until the game gate opens, releases when it closes", () => {
    const { controller, deps } = buildController();

    // Gate closed (game not running): registration is a no-op.
    controller.registerOverlayHotkey();
    expect(deps.globalShortcut.register).not.toHaveBeenCalled();

    // Game opens -> shortcuts grabbed.
    controller.setHotkeysActive(true);
    expect(deps.globalShortcut.register).toHaveBeenCalled();

    // Game closes -> shortcuts released.
    controller.setHotkeysActive(false);
    expect(deps.globalShortcut.unregister).toHaveBeenCalledWith("Control+Alt+R");
  });
});
