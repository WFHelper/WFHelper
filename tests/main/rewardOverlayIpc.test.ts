import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  OVERLAY_CLOSE,
  OVERLAY_INTERACTION_MODE,
  RELIC_REWARD_CONTENT_HEIGHT,
} from "../../config/shared/ipcChannels";

interface FakeController {
  options: { onPresentationEnd?: () => void };
  visible: boolean;
  fitOverlayContentHeight: ReturnType<typeof vi.fn>;
  isOverlayWindowVisible: () => boolean;
  isHiddenByUnfocus: () => boolean;
  clearOverlayAutoHideTimer: ReturnType<typeof vi.fn>;
  hideOverlayWindow: Mock<() => void>;
  createOverlayWindow: ReturnType<typeof vi.fn>;
  setOverlayInteractiveMode: ReturnType<typeof vi.fn>;
  sendOverlayEvent: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: { id: number } }, payload?: unknown) => void>(),
  controllers: [] as unknown[],
  guard: vi.fn(),
  destroyed: false,
  returnFocus: vi.fn(() => true),
  scanTrigger: vi.fn(),
  rivenInteractive: false,
}));

vi.mock("electron", () => ({ app: { getAppPath: () => "D:/app" }, BrowserWindow: {}, screen: {} }));
vi.mock("../../services/logger", () => ({ withScope: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock("../../services/windowSecurity", () => ({ hardenBrowserWindowNavigation: vi.fn() }));
vi.mock("../../services/userDataPath", () => ({ userDataPath: () => "D:/fixture/snapshot.json" }));
vi.mock("../../services/relicService", () => ({}));
vi.mock("../../services/rewardScanner", () => ({
  captureSourceMeta: vi.fn(),
  detectRelicSelectionEra: vi.fn(),
  scanRewardsDetailed: vi.fn(),
}));
vi.mock("../../services/wfmStatsPrice", () => ({
  fetchPriceBySlug: vi.fn(),
  getCachedPriceBySlug: vi.fn(),
}));
vi.mock("../../services/warframeStatus", () => ({}));
vi.mock("../../ipc/context", () => ({
  default: {
    overlayWindow: { isDestroyed: () => state.destroyed, webContents: { id: 7 } },
    plannerOverlayWindow: { isDestroyed: () => false, webContents: { id: 8 } },
    overlaySettings: { relicRewardsOverlayEnabled: true },
    overlayInteractiveMode: false,
  },
}));
vi.mock("../../ipc/overlay/scan", () => ({
  createOverlayScanController: () => ({ onRelicRewardTrigger: state.scanTrigger }),
}));
vi.mock("../../ipc/overlay/relicSelection", () => ({
  createRelicSelectionController: () => ({ suppressReopenForClose: vi.fn() }),
}));
vi.mock("../../ipc/rivenOverlayIpc", () => ({
  isRivenInteractiveMode: () => state.rivenInteractive,
}));
vi.mock("../../ipc/overlay/zOrder", () => ({
  canRaiseOverlayWindows: () => true,
  registerZOrderSubscriber: vi.fn(),
  returnFocusToWarframe: state.returnFocus,
  syncUnfocusHide: vi.fn(),
  syncOverlayWindowZOrder: vi.fn(),
}));
vi.mock("../../ipc/ipcSecurity", () => ({
  assertOverlayRendererSender: state.guard,
  assertMainRendererSender: vi.fn(),
  handleAuthorized: vi.fn(),
  onAuthorized: (
    channel: string,
    guard: unknown,
    handler: (event: { sender: { id: number } }, payload?: unknown) => void,
  ) => {
    if (channel === RELIC_REWARD_CONTENT_HEIGHT) expect(guard).toBe(state.guard);
    state.handlers.set(channel, handler);
  },
}));
vi.mock("../../ipc/overlay/windows", () => ({
  createOverlayWindowBoundsChangeHandler: () => vi.fn(),
  createOverlayWindowsController: (options: { onPresentationEnd?: () => void }) => {
    const controller: FakeController = {
      options,
      visible: false,
      fitOverlayContentHeight: vi.fn(),
      isOverlayWindowVisible: () => controller.visible,
      isHiddenByUnfocus: () => false,
      clearOverlayAutoHideTimer: vi.fn(),
      hideOverlayWindow: vi.fn(() => {
        const wasShown = controller.visible;
        controller.visible = false;
        if (wasShown) controller.options.onPresentationEnd?.();
      }),
      createOverlayWindow: vi.fn((options: { show?: boolean } = {}) => {
        if (options.show !== false) controller.visible = true;
      }),
      setOverlayInteractiveMode: vi.fn(),
      sendOverlayEvent: vi.fn(),
    };
    state.controllers.push(controller);
    return controller;
  },
}));

import ctx from "../../ipc/context";
import { onRelicRewardTrigger, onRelicSelectionClose, register } from "../../ipc/rewardOverlayIpc";

const [reward, planner] = state.controllers as FakeController[];

function resetControllers(): void {
  for (const controller of [reward, planner]) {
    controller.visible = false;
    controller.fitOverlayContentHeight.mockClear();
    controller.clearOverlayAutoHideTimer.mockClear();
    controller.hideOverlayWindow.mockClear();
    controller.createOverlayWindow.mockClear();
    controller.setOverlayInteractiveMode.mockClear();
    controller.sendOverlayEvent.mockClear();
  }
  state.returnFocus.mockClear();
  state.rivenInteractive = false;
}

function interactionEvents(controller: FakeController): unknown[] {
  return controller.sendOverlayEvent.mock.calls
    .filter(([channel]) => channel === OVERLAY_INTERACTION_MODE)
    .map(([, payload]) => payload);
}

describe("reward content height IPC", () => {
  beforeEach(() => {
    state.destroyed = false;
    resetControllers();
    state.handlers.clear();
    register(vi.fn());
  });

  it("accepts a valid height from the current reward renderer", () => {
    state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 7 } }, 310.5);
    expect(reward.fitOverlayContentHeight).toHaveBeenCalledExactlyOnceWith(310.5);
  });

  it.each([undefined, null, "300", {}, 0, -1, NaN, Infinity, 10001])(
    "rejects invalid height %s",
    (height) => {
      state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 7 } }, height);
      expect(reward.fitOverlayContentHeight).not.toHaveBeenCalled();
    },
  );

  it("ignores planner and replaced reward renderers", () => {
    state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 8 } }, 300);
    expect(reward.fitOverlayContentHeight).not.toHaveBeenCalled();
  });

  it("ignores a destroyed reward window", () => {
    state.destroyed = true;
    state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 7 } }, 300);
    expect(reward.fitOverlayContentHeight).not.toHaveBeenCalled();
  });
});

describe("planner close from the game log", () => {
  beforeEach(() => {
    resetControllers();
    ctx.overlayInteractiveMode = false;
  });

  it("hides and drops interactive mode while the planner is on screen", () => {
    planner.visible = true;
    ctx.overlayInteractiveMode = true;

    onRelicSelectionClose();

    expect(planner.clearOverlayAutoHideTimer).toHaveBeenCalledOnce();
    expect(planner.hideOverlayWindow).toHaveBeenCalledOnce();
    expect(ctx.overlayInteractiveMode).toBe(false);
    expect(interactionEvents(planner)).toEqual([{ interactive: false }]);
  });

  // A planner hidden for unfocus is not visible either; the close must still
  // clear that state or the planner comes back for a picker that is gone.
  it("still hides through the controller when nothing is on screen", () => {
    onRelicSelectionClose();

    expect(planner.clearOverlayAutoHideTimer).toHaveBeenCalledOnce();
    expect(planner.hideOverlayWindow).toHaveBeenCalledOnce();
    expect(interactionEvents(planner)).toEqual([]);
  });
});

describe("interactive mode ends with the overlay", () => {
  beforeEach(() => {
    resetControllers();
    state.handlers.clear();
    register(vi.fn());
    ctx.overlayInteractiveMode = true;
  });

  it("an auto-closed overlay leaves the pair click-through and hands focus back", () => {
    reward.visible = true;

    reward.hideOverlayWindow();

    expect(ctx.overlayInteractiveMode).toBe(false);
    for (const controller of [reward, planner]) {
      expect(controller.setOverlayInteractiveMode).toHaveBeenCalledWith(false);
      expect(interactionEvents(controller)).toEqual([{ interactive: false }]);
    }
    expect(state.returnFocus).toHaveBeenCalledOnce();
    expect(state.returnFocus.mock.invocationCallOrder[0]).toBeGreaterThan(
      reward.setOverlayInteractiveMode.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves focus with riven panels the player is still using", () => {
    reward.visible = true;
    state.rivenInteractive = true;

    reward.hideOverlayWindow();

    expect(ctx.overlayInteractiveMode).toBe(false);
    expect(state.returnFocus).not.toHaveBeenCalled();
  });

  it("keeps the mode while the other overlay of the pair is still up", () => {
    reward.visible = true;
    planner.visible = true;

    reward.hideOverlayWindow();

    expect(ctx.overlayInteractiveMode).toBe(true);
    expect(planner.setOverlayInteractiveMode).not.toHaveBeenCalled();
    expect(state.returnFocus).not.toHaveBeenCalled();
  });

  it("the close button ends it for a sibling still on screen too", () => {
    reward.visible = true;
    planner.visible = true;

    state.handlers.get(OVERLAY_CLOSE)!({ sender: { id: 7 } });

    expect(reward.hideOverlayWindow).toHaveBeenCalledOnce();
    expect(planner.hideOverlayWindow).not.toHaveBeenCalled();
    expect(ctx.overlayInteractiveMode).toBe(false);
    expect(planner.setOverlayInteractiveMode).toHaveBeenCalledWith(false);
    expect(interactionEvents(planner)).toEqual([{ interactive: false }]);
  });

  it("a reward overlay opening fresh starts click-through", () => {
    onRelicRewardTrigger("eelog", 0, vi.fn(), async () => {});

    expect(ctx.overlayInteractiveMode).toBe(false);
    expect(reward.setOverlayInteractiveMode.mock.calls[0]).toEqual([false]);
    expect(reward.setOverlayInteractiveMode.mock.invocationCallOrder[0]).toBeLessThan(
      reward.createOverlayWindow.mock.invocationCallOrder[0]!,
    );
    expect(state.scanTrigger).toHaveBeenCalledWith("eelog", 0);
  });

  it("an EE.log trigger keeps the last round's card off screen until its own scan", () => {
    onRelicRewardTrigger("eelog", 0, vi.fn(), async () => {});
    expect(reward.visible).toBe(false);

    onRelicRewardTrigger("hotkey", 0, vi.fn(), async () => {});
    expect(reward.visible).toBe(true);
  });

  it("a reward overlay joining a planner already on screen keeps its mode", () => {
    planner.visible = true;

    onRelicRewardTrigger("eelog", 0, vi.fn(), async () => {});

    expect(ctx.overlayInteractiveMode).toBe(true);
    expect(reward.setOverlayInteractiveMode).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("linux interactive default", () => {
  const realPlatform = process.platform;
  const settings = () => ctx.overlaySettings as Record<string, unknown>;
  const setPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value, configurable: true });

  beforeEach(() => {
    resetControllers();
    state.handlers.clear();
    register(vi.fn());
    ctx.overlayInteractiveMode = false;
    settings().linuxOverlaysInteractive = true;
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(realPlatform);
    delete settings().linuxOverlaysInteractive;
    ctx.overlayInteractiveMode = false;
  });

  it("a fresh reward overlay opens taking clicks and tells its renderer", () => {
    onRelicRewardTrigger("eelog", 0, vi.fn(), async () => {});

    expect(ctx.overlayInteractiveMode).toBe(true);
    expect(reward.setOverlayInteractiveMode.mock.calls[0]).toEqual([true]);
    expect(reward.setOverlayInteractiveMode.mock.invocationCallOrder[0]).toBeLessThan(
      reward.createOverlayWindow.mock.invocationCallOrder[0]!,
    );
    expect(interactionEvents(reward).at(-1)).toEqual({ interactive: true });
  });

  it("a hotkey switch to click-through lasts until the pair closes", () => {
    planner.visible = true;

    onRelicRewardTrigger("eelog", 0, vi.fn(), async () => {});
    expect(ctx.overlayInteractiveMode).toBe(false);

    planner.visible = false;
    reward.visible = true;
    reward.hideOverlayWindow();

    expect(ctx.overlayInteractiveMode).toBe(true);
    for (const controller of [reward, planner]) {
      expect(controller.setOverlayInteractiveMode).toHaveBeenLastCalledWith(true);
      expect(interactionEvents(controller).at(-1)).toEqual({ interactive: true });
    }
    expect(state.returnFocus).not.toHaveBeenCalled();
  });

  it("is ignored on Windows", () => {
    setPlatform("win32");
    ctx.overlayInteractiveMode = true;

    onRelicRewardTrigger("eelog", 0, vi.fn(), async () => {});

    expect(ctx.overlayInteractiveMode).toBe(false);
    expect(reward.setOverlayInteractiveMode.mock.calls[0]).toEqual([false]);
    expect(state.returnFocus).toHaveBeenCalledOnce();
  });
});
