import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARBI_SUMMARY_CLOSE, ARBI_SUMMARY_READY } from "../../config/shared/ipcChannels";

const state = vi.hoisted(() => {
  const value = {
    visible: true,
    handlers: new Map<string, (event: { sender: { id: number } }) => void>(),
    mouse: vi.fn(),
    focusable: vi.fn(),
    ready: vi.fn(() => true),
    clearAutoHide: vi.fn(),
    hide: vi.fn(() => {
      value.visible = false;
    }),
  };
  return value;
});

vi.mock("electron", () => ({ app: { getAppPath: () => "D:/app" }, BrowserWindow: {}, screen: {} }));
vi.mock("../../services/logger", () => ({ withScope: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock("../../services/windowSecurity", () => ({ hardenBrowserWindowNavigation: vi.fn() }));
vi.mock("../../ipc/context", () => ({
  default: {
    arbiSummaryWindow: { isDestroyed: () => false, setFocusable: state.focusable },
    overlaySettings: {},
  },
}));
vi.mock("../../ipc/overlay/clickThrough", () => ({ setClickThrough: state.mouse }));
vi.mock("../../ipc/ipcSecurity", () => ({
  assertArbiSummarySender: vi.fn(),
  onAuthorized: (
    channel: string,
    _guard: unknown,
    handler: (event: { sender: { id: number } }) => void,
  ) => {
    state.handlers.set(channel, handler);
  },
}));
vi.mock("../../ipc/overlay/zOrder", () => ({
  registerZOrderSubscriber: vi.fn(),
  syncUnfocusHide: vi.fn(),
}));
vi.mock("../../ipc/overlay/windows", () => ({
  createOverlayWindowBoundsChangeHandler: () => vi.fn(),
  createOverlayWindowsController: () => ({
    isOverlayWindowVisible: () => state.visible,
    clearOverlayAutoHideTimer: state.clearAutoHide,
    hideOverlayWindow: state.hide,
    markRendererReady: state.ready,
  }),
}));

import { register } from "../../ipc/arbiOverlayIpc";

describe("arbitration overlay readiness", () => {
  beforeEach(() => {
    state.visible = true;
    state.mouse.mockClear();
    state.focusable.mockClear();
    state.ready.mockClear();
    state.hide.mockClear();
    state.clearAutoHide.mockClear();
    state.handlers.clear();
    register();
  });

  it("leaves the window's input state to the controller when the renderer reports ready", () => {
    state.handlers.get(ARBI_SUMMARY_READY)!({ sender: { id: 1 } });

    expect(state.ready).toHaveBeenCalledExactlyOnceWith(1);
    expect(state.mouse).not.toHaveBeenCalled();
    expect(state.focusable).not.toHaveBeenCalled();
  });

  it("closes through the controller and leaves the window mapped", () => {
    state.handlers.get(ARBI_SUMMARY_CLOSE)!({ sender: { id: 1 } });

    expect(state.clearAutoHide).toHaveBeenCalledOnce();
    expect(state.hide).toHaveBeenCalledOnce();
    expect(state.visible).toBe(false);
  });

  // A summary hidden for unfocus is not visible either; the close must still
  // clear that state or the summary comes back on refocus with no timer.
  it("hides through the controller even when nothing is on screen", () => {
    state.visible = false;
    state.handlers.get(ARBI_SUMMARY_CLOSE)!({ sender: { id: 1 } });

    expect(state.clearAutoHide).toHaveBeenCalledOnce();
    expect(state.hide).toHaveBeenCalledOnce();
  });
});
