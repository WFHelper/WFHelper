import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakePair {
  visible: boolean;
  restoreAfterUnfocus: ReturnType<typeof vi.fn>;
  isOverlayWindowVisible: () => boolean;
  setOverlayInteractiveMode: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => {
  const pair = () => {
    const controller = {
      visible: false,
      restoreAfterUnfocus: vi.fn(),
      isOverlayWindowVisible: () => controller.visible,
      setOverlayInteractiveMode: vi.fn(),
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
  handleAuthorized: vi.fn(),
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
    return { saveOverlaySettings: vi.fn() };
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
}));
vi.mock("../../ipc/rewardOverlayIpc", () => ({
  rewardWindowsController: state.reward,
  plannerWindowsController: state.planner,
  pushOverlayInteractionMode: state.push,
  configureOverlaySettingsPersistence: vi.fn(),
}));
vi.mock("../../ipc/arbiOverlayIpc", () => ({ configureOverlaySettingsPersistence: vi.fn() }));
vi.mock("../../services/arbiRunTracker", () => ({}));
vi.mock("../../services/profitTakerTracker", () => ({}));
vi.mock("../../services/missionRewards", () => ({}));
vi.mock("../../services/wfmPresence", () => ({}));
vi.mock("../../services/inventorySync", () => ({}));
vi.mock("../../services/rewardScanDebug", () => ({ setOcrDebugDumpsEnabled: vi.fn() }));
vi.mock("../../ipc/mainWindowZoom", () => ({ applyMainWindowZoom: vi.fn() }));
vi.mock("../../ipc/context", () => ({
  default: {
    overlayWindow: { isDestroyed: () => false },
    plannerOverlayWindow: { isDestroyed: () => false },
    rivenOverlayLeftWindow: { isDestroyed: () => false },
    rivenOverlayRightWindow: null,
    overlayInteractiveMode: false,
    overlaySettings: {},
  },
}));

import ctx from "../../ipc/context";
import "../../ipc/overlayIpc";

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
    state.toggle!("hotkey");

    expect(state.captureFocus).not.toHaveBeenCalled();
    expect(state.returnFocus).not.toHaveBeenCalled();
    expect(ctx.overlayInteractiveMode).toBe(false);
  });
});
