import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_SET_SETTINGS } from "../../config/shared/ipcChannels";

interface FakePair {
  visible: boolean;
  restoreAfterUnfocus: ReturnType<typeof vi.fn>;
  isOverlayWindowVisible: () => boolean;
  setOverlayInteractiveMode: ReturnType<typeof vi.fn>;
}

type SettingsHandler = (event: unknown, next: unknown) => Promise<unknown>;

const state = vi.hoisted(() => {
  const pair = () => {
    const controller = {
      visible: false,
      restoreAfterUnfocus: vi.fn(),
      isOverlayWindowVisible: () => controller.visible,
      setOverlayInteractiveMode: vi.fn(),
      positionOverlayWindow: vi.fn(),
      getAnchorMeta: () => null,
    };
    return controller;
  };
  return {
    toggle: null as ((source?: string) => void) | null,
    reward: pair(),
    planner: pair(),
    rivenVisible: false,
    rivenHiddenByUnfocus: false,
    rivenInteractive: false,
    setRivenInteractiveMode: vi.fn(),
    captureFocus: vi.fn(),
    returnFocus: vi.fn(() => true),
    push: vi.fn(),
    handlers: new Map<string, unknown>(),
    savedSettings: {} as Record<string, unknown>,
  };
});

vi.mock("electron", () => ({
  app: { on: vi.fn(), getAppPath: () => "D:/app" },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  screen: {},
}));
vi.mock("../../services/logger", () => ({ withScope: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock("../../ipc/overlay/editorIpc", () => ({ registerOverlayEditor: vi.fn() }));
vi.mock("../../ipc/ipcSecurity", () => ({
  assertLocalizedOverlaySender: vi.fn(),
  assertMainRendererSender: vi.fn(),
  assertOverlayRendererSender: vi.fn(),
  handleAuthorized: (channel: string, _guard: unknown, handler: unknown) => {
    state.handlers.set(channel, handler);
  },
  onAuthorized: vi.fn(),
}));
vi.mock("../../ipc/overlayI18n", () => ({ overlayMessages: vi.fn(), setOverlayLocale: vi.fn() }));
vi.mock("../../ipc/trayIpc", () => ({
  createTray: vi.fn(),
  destroyTray: vi.fn(),
  isTrayActive: vi.fn(),
}));
vi.mock("../../ipc/hotkeyRegistry", () => ({
  disposeAppHotkeys: vi.fn(),
  overlayHotkeyBackend: {},
}));
vi.mock("../../ipc/overlay/settings", () => ({
  createOverlaySettingsController: (options: {
    onToggleOverlayInteractionMode: (source?: string) => void;
  }) => {
    state.toggle = options.onToggleOverlayInteractionMode;
    return {
      saveOverlaySettings: vi.fn(),
      loadOverlaySettings: () => state.savedSettings,
      registerOverlayHotkey: vi.fn(),
      setOverlaySettingsWithLifecycle: async (next: Record<string, unknown>) => {
        const ctx = (await import("../../ipc/context")).default;
        ctx.overlaySettings = { ...ctx.overlaySettings, ...next };
        return ctx.overlaySettings;
      },
    };
  },
}));
vi.mock("../../ipc/overlay/windows", () => ({ moveOverlayWindowBy: vi.fn() }));
vi.mock("../../ipc/overlay/zOrder", () => ({ returnFocusToWarframe: state.returnFocus }));
vi.mock("../../ipc/tradeNotificationIpc", () => ({
  getTradeNotificationPlacementRect: vi.fn(),
  hideTradeNotification: vi.fn(),
}));
vi.mock("../../services/atomicFile", () => ({ writeFileAtomicSync: vi.fn() }));
vi.mock("../../services/userDataPath", () => ({ userDataPath: () => "D:/fixture/overlay.json" }));
vi.mock("../../services/acceleratorVk", () => ({ matchesAcceleratorInput: vi.fn() }));
vi.mock("../../services/eeLogPath", () => ({ resolveWarframeUiScale: vi.fn() }));
vi.mock("../../services/warframeStatus", () => ({ captureWarframeFocus: state.captureFocus }));
vi.mock("../../services/warframeLifecycle", () => ({ configureWarframeLifecycle: vi.fn() }));
vi.mock("../../ipc/rivenOverlayIpc", () => ({
  isAnyRivenWindowVisible: () => state.rivenVisible,
  restoreRivenAfterUnfocus: () => {
    if (!state.rivenHiddenByUnfocus) return;
    state.rivenHiddenByUnfocus = false;
    state.rivenVisible = true;
  },
  isRivenInteractiveMode: () => state.rivenInteractive,
  setRivenInteractiveMode: state.setRivenInteractiveMode,
  onRivenManualRescan: vi.fn(),
  configureOverlaySettingsPersistence: vi.fn(),
  positionRivenOverlayWindows: vi.fn(),
  register: vi.fn(),
}));
vi.mock("../../ipc/rewardOverlayIpc", () => ({
  rewardWindowsController: state.reward,
  plannerWindowsController: state.planner,
  pushOverlayInteractionMode: state.push,
  configureOverlaySettingsPersistence: vi.fn(),
  register: vi.fn(),
}));
vi.mock("../../ipc/arbiOverlayIpc", () => ({
  configureOverlaySettingsPersistence: vi.fn(),
  register: vi.fn(),
}));
vi.mock("../../services/arbiRunTracker", () => ({ setArbiTrackingEnabled: vi.fn() }));
vi.mock("../../services/profitTakerTracker", () => ({ setPtTrackingEnabled: vi.fn() }));
vi.mock("../../services/missionRewards", () => ({ setTrackingEnabled: vi.fn() }));
vi.mock("../../services/wfmPresence", () => ({ setOptions: vi.fn() }));
vi.mock("../../services/inventorySync", () => ({ apply: vi.fn() }));
vi.mock("../../services/rewardScanDebug", () => ({ setOcrDebugDumpsEnabled: vi.fn() }));
vi.mock("../../ipc/mainWindowZoom", () => ({ applyMainWindowZoom: vi.fn() }));
vi.mock("../../ipc/context", () => ({
  default: {
    overlayWindow: { isDestroyed: () => false },
    plannerOverlayWindow: { isDestroyed: () => false },
    rivenOverlayLeftWindow: { isDestroyed: () => false },
    rivenOverlayRightWindow: null,
    overlayInteractiveMode: false,
    overlaySettings: {} as Record<string, unknown>,
  },
}));

import ctx from "../../ipc/context";
import { loadOverlaySettings, register, toggleOverlayInteractionMode } from "../../ipc/overlayIpc";

const pair = [state.reward, state.planner] as FakePair[];

beforeEach(() => {
  for (const controller of pair) {
    controller.visible = false;
    controller.setOverlayInteractiveMode.mockClear();
  }
  state.rivenVisible = false;
  state.rivenHiddenByUnfocus = false;
  state.rivenInteractive = false;
  state.setRivenInteractiveMode.mockClear();
  state.captureFocus.mockClear();
  state.returnFocus.mockClear();
  ctx.overlayInteractiveMode = false;
});

describe("overlay interaction hotkey", () => {
  it("focuses the overlays it turns interactive, and only then", () => {
    state.reward.visible = true;

    state.toggle!("hotkey");

    expect(ctx.overlayInteractiveMode).toBe(true);
    expect(state.captureFocus).toHaveBeenCalledOnce();
    expect(state.reward.setOverlayInteractiveMode).toHaveBeenCalledWith(true, { focus: true });
    expect(state.returnFocus).not.toHaveBeenCalled();
  });

  // setFocusable(false) hands the foreground down the z-order, so the return to
  // the game has to come after it or that hand-off undoes it.
  it("hands focus back to the game after the overlays went passive", () => {
    state.reward.visible = true;
    ctx.overlayInteractiveMode = true;

    state.toggle!("hotkey");

    expect(ctx.overlayInteractiveMode).toBe(false);
    expect(state.returnFocus).toHaveBeenCalledOnce();
    expect(state.returnFocus.mock.invocationCallOrder[0]).toBeGreaterThan(
      state.reward.setOverlayInteractiveMode.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("a riven-only toggle leaves the hidden reward pair passive", () => {
    state.rivenVisible = true;

    state.toggle!("hotkey");

    expect(state.setRivenInteractiveMode).toHaveBeenCalledWith(true);
    expect(ctx.overlayInteractiveMode).toBe(false);
    for (const controller of pair) {
      expect(controller.setOverlayInteractiveMode).not.toHaveBeenCalled();
    }
  });

  it("brings riven panels hidden for unfocus back interactive", () => {
    state.rivenHiddenByUnfocus = true;

    state.toggle!("hotkey");

    expect(state.rivenVisible).toBe(true);
    expect(state.setRivenInteractiveMode).toHaveBeenCalledWith(true);
  });

  it("does nothing while no overlay is on screen", () => {
    expect(toggleOverlayInteractionMode("hotkey")).toBeNull();

    expect(state.captureFocus).not.toHaveBeenCalled();
    expect(state.returnFocus).not.toHaveBeenCalled();
    expect(ctx.overlayInteractiveMode).toBe(false);
  });
});

describe("overlay interaction launch flag", () => {
  it("runs the same toggle as the interaction hotkey", () => {
    expect(toggleOverlayInteractionMode).toBe(state.toggle);
  });

  it("reports the mode the overlays on screen switched to", () => {
    state.reward.visible = true;

    expect(toggleOverlayInteractionMode("launch-flag")).toBe(true);
    expect(toggleOverlayInteractionMode("launch-flag")).toBe(false);
  });
});

describe("linux interactive overlay setting", () => {
  const realPlatform = process.platform;
  let saveSettings: SettingsHandler;

  const setPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value, configurable: true });

  beforeAll(() => {
    register();
    saveSettings = state.handlers.get(OVERLAY_SET_SETTINGS) as SettingsHandler;
  });

  beforeEach(() => {
    setPlatform("linux");
    ctx.overlaySettings = {} as typeof ctx.overlaySettings;
    state.push.mockClear();
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("switches the open overlays both ways without taking focus", async () => {
    state.reward.visible = true;

    await saveSettings({}, { linuxOverlaysInteractive: true });

    expect(ctx.overlayInteractiveMode).toBe(true);
    for (const controller of pair) {
      expect(controller.setOverlayInteractiveMode).toHaveBeenCalledExactlyOnceWith(true, {
        focus: false,
      });
    }
    expect(state.setRivenInteractiveMode).toHaveBeenCalledExactlyOnceWith(true, { focus: false });
    expect(state.push).toHaveBeenCalledOnce();

    await saveSettings({}, { linuxOverlaysInteractive: false });

    expect(ctx.overlayInteractiveMode).toBe(false);
    expect(state.reward.setOverlayInteractiveMode).toHaveBeenLastCalledWith(false, {
      focus: false,
    });
    expect(state.setRivenInteractiveMode).toHaveBeenLastCalledWith(false, { focus: false });
    expect(state.captureFocus).not.toHaveBeenCalled();
    expect(state.returnFocus).not.toHaveBeenCalled();
  });

  it("leaves the overlays alone when a save keeps the setting", async () => {
    ctx.overlaySettings = { linuxOverlaysInteractive: true } as typeof ctx.overlaySettings;

    await saveSettings({}, { linuxOverlaysInteractive: true, overlayScale: 1 });

    for (const controller of pair)
      expect(controller.setOverlayInteractiveMode).not.toHaveBeenCalled();
    expect(state.setRivenInteractiveMode).not.toHaveBeenCalled();
  });

  // The planner is pre-warmed before any overlay opens; a stale passive mode there
  // makes X11 rebuild it on its first show.
  it("starts in the saved mode before the first overlay opens", () => {
    state.savedSettings = { linuxOverlaysInteractive: true };

    loadOverlaySettings();
    expect(ctx.overlayInteractiveMode).toBe(true);

    setPlatform("win32");
    loadOverlaySettings();
    expect(ctx.overlayInteractiveMode).toBe(false);
    state.savedSettings = {};
  });

  it("does nothing on Windows", async () => {
    setPlatform("win32");

    await saveSettings({}, { linuxOverlaysInteractive: true });

    expect(ctx.overlayInteractiveMode).toBe(false);
    for (const controller of pair)
      expect(controller.setOverlayInteractiveMode).not.toHaveBeenCalled();
    expect(state.setRivenInteractiveMode).not.toHaveBeenCalled();
  });
});
