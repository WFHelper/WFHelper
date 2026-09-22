import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELIC_REWARD_CONTENT_HEIGHT } from "../../config/shared/ipcChannels";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: { id: number } }, payload?: unknown) => void>(),
  fit: vi.fn(),
  guard: vi.fn(),
  destroyed: false,
  plannerVisible: true,
  clearAutoHide: vi.fn(),
  hide: vi.fn(),
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
    overlaySettings: {},
  },
}));
vi.mock("../../ipc/overlay/scan", () => ({ createOverlayScanController: () => ({}) }));
vi.mock("../../ipc/overlay/relicSelection", () => ({ createRelicSelectionController: () => ({}) }));
vi.mock("../../ipc/overlay/zOrder", () => ({
  canRaiseOverlayWindows: () => true,
  registerZOrderSubscriber: vi.fn(),
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
  createOverlayWindowsController: () => ({
    fitOverlayContentHeight: state.fit,
    isOverlayWindowVisible: () => state.plannerVisible,
    clearOverlayAutoHideTimer: state.clearAutoHide,
    hideOverlayWindow: state.hide,
  }),
}));

import { onRelicSelectionClose, register } from "../../ipc/rewardOverlayIpc";

describe("reward content height IPC", () => {
  beforeEach(() => {
    state.destroyed = false;
    state.fit.mockClear();
    state.handlers.clear();
    register(vi.fn(), vi.fn());
  });

  it("accepts a valid height from the current reward renderer", () => {
    state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 7 } }, 310.5);
    expect(state.fit).toHaveBeenCalledExactlyOnceWith(310.5);
  });

  it.each([undefined, null, "300", {}, 0, -1, NaN, Infinity, 10001])(
    "rejects invalid height %s",
    (height) => {
      state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 7 } }, height);
      expect(state.fit).not.toHaveBeenCalled();
    },
  );

  it("ignores planner and replaced reward renderers", () => {
    state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 8 } }, 300);
    expect(state.fit).not.toHaveBeenCalled();
  });

  it("ignores a destroyed reward window", () => {
    state.destroyed = true;
    state.handlers.get(RELIC_REWARD_CONTENT_HEIGHT)!({ sender: { id: 7 } }, 300);
    expect(state.fit).not.toHaveBeenCalled();
  });
});

describe("planner close from the game log", () => {
  beforeEach(() => {
    state.clearAutoHide.mockClear();
    state.hide.mockClear();
  });

  it("hides and drops interactive mode while the planner is on screen", () => {
    state.plannerVisible = true;
    const push = vi.fn();

    onRelicSelectionClose(push);

    expect(state.clearAutoHide).toHaveBeenCalledOnce();
    expect(state.hide).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
  });

  // A planner hidden for unfocus is not visible either; the close must still
  // clear that state or the planner comes back for a picker that is gone.
  it("still hides through the controller when nothing is on screen", () => {
    state.plannerVisible = false;
    const push = vi.fn();

    onRelicSelectionClose(push);

    expect(state.clearAutoHide).toHaveBeenCalledOnce();
    expect(state.hide).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });
});
