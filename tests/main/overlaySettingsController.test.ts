import { describe, expect, it, vi } from "vitest";

import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings";
import { createOverlaySettingsController } from "../../ipc/overlay/settings";

function buildController() {
  const ctx = {
    overlaySettings: { ...OVERLAY_SETTINGS_DEFAULTS, hotkey: "Control+Alt+R" },
    overlayHotkeyRegistered: null,
    overlayInteractionHotkeyRegistered: null,
    rivenRescanHotkeyRegistered: null,
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
    onRivenRescanTrigger: vi.fn(),
    configureWarframeLifecycle: vi.fn(async (_enabled: boolean) => {}),
  };

  const controller = createOverlaySettingsController(
    deps as unknown as Parameters<typeof createOverlaySettingsController>[0],
  );
  return { controller, deps, ctx, registerCallbacks };
}

describe("overlay settings controller", () => {
  it("preserves native resize precision when settings are saved and reloaded", () => {
    const { controller, deps } = buildController();
    const saved = controller.setOverlaySettings({ overlayWindowScales: { planner: 1.237 } });
    expect(saved.overlayWindowScales?.planner).toBe(1.237);
    deps.fs.existsSync.mockReturnValue(true);
    deps.fs.readFileSync.mockReturnValue(JSON.stringify(saved));
    expect(controller.loadOverlaySettings().overlayWindowScales?.planner).toBe(1.237);
  });

  it("loads a legacy reward layout and preserves it through unrelated settings saves", () => {
    const { controller, deps } = buildController();
    const rewardLayout = {
      version: 1,
      fields: { platinumValue: { x: 35, y: -4, scale: 2, color: "#123456", hidden: false } },
    };
    // Loading restores the opt-in reward fields alongside what the file held.
    const normalized = {
      version: 1,
      fields: {
        vaulted: { x: 0, y: 0, scale: 1, color: null, hidden: true },
        ...rewardLayout.fields,
      },
    };
    deps.fs.existsSync.mockReturnValue(true);
    deps.fs.readFileSync.mockReturnValue(JSON.stringify({ rewardLayout }));
    const loaded = controller.loadOverlaySettings();
    expect(loaded.rewardLayout).toEqual(normalized);
    expect(loaded.overlayLayouts?.planner?.fields.reward0Name?.hidden).toBe(true);
    const saved = controller.setOverlaySettings({ notificationSoundEnabled: false });
    expect(saved.rewardLayout).toEqual(normalized);
    expect(JSON.parse(deps.writeFileAtomic.mock.calls.at(-1)![1]).rewardLayout).toEqual(normalized);
  });

  it("retains editor layouts across ordinary settings saves and strips foreign fields", () => {
    const { controller } = buildController();
    controller.setOverlaySettings({
      overlayLayouts: {
        planner: {
          version: 1,
          fields: { relicName: { scale: 2, hidden: true }, weaponName: { scale: 3 } },
        },
        rivenRight: { version: 1, fields: { weaponName: { color: "#123456" } } },
        untrusted: { version: 1, fields: { anything: { scale: 3 } } },
      },
    });
    const saved = controller.setOverlaySettings({ notificationSoundEnabled: false });
    expect(saved.overlayLayouts?.planner?.fields.relicName).toMatchObject({
      scale: 2,
      hidden: true,
    });
    expect(saved.overlayLayouts?.planner?.fields).not.toHaveProperty("weaponName");
    expect(saved.overlayLayouts?.rivenRight?.fields.weaponName).toMatchObject({ color: "#123456" });
    expect(saved.overlayLayouts).not.toHaveProperty("untrusted");
  });

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

  it("defaults and bounds notification volume without losing mute", () => {
    const { controller } = buildController();
    for (const [input, expected] of [
      [undefined, 1],
      [0, 0],
      [0.37, 0.37],
      [2, 1],
      [-1, 0],
      [NaN, 1],
      [Infinity, 1],
      ["0.4", 1],
    ]) {
      expect(
        controller.normalizeOverlaySettings({ notificationSoundVolume: input })
          .notificationSoundVolume,
      ).toBe(expected);
    }
  });

  it("keeps the saved notification volume when a save omits it", () => {
    const { controller, ctx } = buildController();
    controller.setOverlaySettings({ notificationSoundVolume: 0.37 });
    controller.setOverlaySettings({ notificationSoundEnabled: false });
    expect(ctx.overlaySettings.notificationSoundVolume).toBe(0.37);
    expect(ctx.overlaySettings.notificationSoundEnabled).toBe(false);
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
        reward: { x: 120, y: 240, displayId: "7", width: 960.5, height: 200 },
        arbiSummary: { x: 15, y: 25, width: "invalid", height: 200 },
        nope: { x: 1, y: 2 },
        planner: { x: "bad", y: 10 },
      },
    });

    expect(normalized.overlayScale).toBe(1.5);
    expect(normalized.overlayWindowBounds).toEqual({
      reward: { x: 120, y: 240, displayId: "7", width: 960.5, height: 200 },
      arbiSummary: { x: 15, y: 25 },
    });
  });

  // Files written before the trade toast joined the placement steps have no
  // entry for it, and that absence is what keeps its top-right default.
  it("loads a file without a trade toast position unchanged", () => {
    const { controller, deps } = buildController();
    const legacyBounds = {
      reward: { x: 120, y: 240, displayId: "7" },
      rivenLeft: { x: 30, y: 40 },
    };
    deps.fs.existsSync.mockReturnValue(true);
    deps.fs.readFileSync.mockReturnValue(
      JSON.stringify({ overlayWindowBounds: legacyBounds, overlayWindowScales: { reward: 1.2 } }),
    );

    const loaded = controller.loadOverlaySettings();

    expect(loaded.overlayWindowBounds).toEqual(legacyBounds);
    expect(loaded.overlayWindowBounds).not.toHaveProperty("tradeNotification");
    expect(loaded.overlayWindowScales).toEqual({ reward: 1.2 });
  });

  it("round-trips a saved trade toast position through save and load", () => {
    const { controller, deps } = buildController();
    const saved = controller.setOverlaySettings({
      overlayWindowBounds: { tradeNotification: { x: 640.4, y: 88, displayId: "2" } },
    });
    expect(saved.overlayWindowBounds?.tradeNotification).toEqual({ x: 640, y: 88, displayId: "2" });

    deps.fs.existsSync.mockReturnValue(true);
    deps.fs.readFileSync.mockReturnValue(JSON.stringify(saved));

    expect(controller.loadOverlaySettings().overlayWindowBounds?.tradeNotification).toEqual({
      x: 640,
      y: 88,
      displayId: "2",
    });
  });

  // The toast has a fixed size, so an imported scale for it is dropped.
  it("never keeps a scale for the fixed-size trade toast", () => {
    const { controller } = buildController();

    const normalized = controller.normalizeOverlaySettings({
      overlayWindowScales: { tradeNotification: 1.3, planner: 1.1 },
    });

    expect(normalized.overlayWindowScales).toEqual({ planner: 1.1 });
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

  it("keeps mission tracking off unless it is set", () => {
    const { controller } = buildController();

    expect(OVERLAY_SETTINGS_DEFAULTS.missionTrackingEnabled).toBe(false);
    expect(controller.normalizeOverlaySettings({}).missionTrackingEnabled).toBe(false);
    expect(
      controller.normalizeOverlaySettings({ arbiTrackingEnabled: true }).missionTrackingEnabled,
    ).toBe(false);
    expect(
      controller.normalizeOverlaySettings({ missionTrackingEnabled: true }).missionTrackingEnabled,
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

  it("restores the previous settings and throws when an atomic write fails", () => {
    const { controller, deps, ctx } = buildController();
    controller.setOverlaySettings({
      uiScale: 1.15,
      rewardLayout: { version: 1, fields: { rarity: { hidden: true } } },
    });
    const previous = ctx.overlaySettings;
    deps.writeFileAtomic.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() =>
      controller.setOverlaySettings({ uiScale: 1.4, rewardLayout: { version: 1, fields: {} } }),
    ).toThrow("Could not save overlay settings");
    expect(ctx.overlaySettings).toBe(previous);
    expect(deps.log.error).toHaveBeenCalledWith(
      "[OverlaySettings] Failed to save settings:",
      "disk full",
    );
    const recovered = controller.setOverlaySettings({ notificationSoundEnabled: false });
    expect(recovered.uiScale).toBe(1.15);
    expect(recovered.rewardLayout?.fields.rarity?.hidden).toBe(true);
    expect(recovered.notificationSoundEnabled).toBe(false);
  });

  it("rolls back lifecycle on a failed save before accepting the next update", async () => {
    const { controller, deps, ctx } = buildController();
    const calls: boolean[] = [];
    let enabled = false;
    deps.configureWarframeLifecycle.mockImplementation(async (next) => {
      calls.push(next);
      enabled = next;
    });
    deps.writeFileAtomic.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const failed = controller.setOverlaySettingsWithLifecycle({ warframeLifecycleEnabled: true });
    const next = controller.setOverlaySettingsWithLifecycle({ warframeLifecycleEnabled: true });
    await expect(failed).rejects.toThrow("Could not save overlay settings");
    await expect(next).resolves.toMatchObject({ warframeLifecycleEnabled: true });
    expect(calls).toEqual([true, false, true]);
    expect(enabled).toBe(true);
    expect(ctx.overlaySettings.warframeLifecycleEnabled).toBe(true);
    expect(JSON.parse(deps.writeFileAtomic.mock.calls.at(-1)![1]).warframeLifecycleEnabled).toBe(
      true,
    );
  });

  it("rechecks the save guard after awaiting lifecycle and rolls back when it changed", async () => {
    const { controller, deps, ctx } = buildController();
    const previous = ctx.overlaySettings;
    let finishEnable: (() => void) | undefined;
    const enabling = new Promise<void>((resolve) => {
      finishEnable = resolve;
    });
    let enabled = false;
    deps.configureWarframeLifecycle.mockImplementation(async (next) => {
      if (next) await enabling;
      enabled = next;
    });
    let editorOpen = false;
    const guard = vi.fn(() => {
      if (editorOpen) throw new Error("Close the overlay editor before importing layouts");
    });
    const pending = controller.setOverlaySettingsWithLifecycle(
      { warframeLifecycleEnabled: true, rewardLayout: { version: 1, fields: {} } },
      guard,
    );
    await Promise.resolve();
    expect(deps.configureWarframeLifecycle).toHaveBeenCalledWith(true);
    expect(guard).not.toHaveBeenCalled();
    editorOpen = true;
    finishEnable!();
    await expect(pending).rejects.toThrow("Close the overlay editor before importing layouts");
    expect(deps.configureWarframeLifecycle.mock.calls).toEqual([[true], [false]]);
    expect(enabled).toBe(false);
    expect(ctx.overlaySettings).toBe(previous);
    expect(deps.writeFileAtomic).not.toHaveBeenCalled();
  });

  it("does not save settings when lifecycle configuration fails", async () => {
    const { controller, deps, ctx } = buildController();
    deps.configureWarframeLifecycle.mockRejectedValueOnce(new Error("login registration failed"));
    await expect(
      controller.setOverlaySettingsWithLifecycle({ warframeLifecycleEnabled: true }),
    ).rejects.toThrow("login registration failed");
    expect(ctx.overlaySettings.warframeLifecycleEnabled).toBe(false);
    expect(deps.writeFileAtomic).not.toHaveBeenCalled();
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

  it("registers the riven rescan hotkey and releases it with the others", () => {
    const { controller, deps, ctx, registerCallbacks } = buildController();
    controller.setHotkeysActive(true);

    const accelerator = String(OVERLAY_SETTINGS_DEFAULTS.rivenRescanHotkey);
    expect(ctx.rivenRescanHotkeyRegistered).toBe(accelerator);
    registerCallbacks.get(accelerator)?.();
    expect(deps.onRivenRescanTrigger).toHaveBeenCalledWith("hotkey");

    controller.setHotkeysActive(false);
    expect(deps.globalShortcut.unregister).toHaveBeenCalledWith(accelerator);
    expect(ctx.rivenRescanHotkeyRegistered).toBeNull();
  });

  it("keeps a cleared riven rescan hotkey on its default instead of unbinding it", () => {
    const { controller } = buildController();
    expect(controller.normalizeOverlaySettings({ rivenRescanHotkey: "" }).rivenRescanHotkey).toBe(
      OVERLAY_SETTINGS_DEFAULTS.rivenRescanHotkey,
    );
    expect(controller.normalizeOverlaySettings({ rivenRescanHotkey: "f6" }).rivenRescanHotkey).toBe(
      "F6",
    );
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
