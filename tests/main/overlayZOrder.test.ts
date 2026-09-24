import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { once: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock("../../services/warframeStatus", () => ({
  getStatus: vi.fn(),
  isWindowTopmost: vi.fn(() => null),
  isWarframeOrWindowForeground: vi.fn(() => false),
  isWarframeForegroundNow: vi.fn(() => null),
  isWarframeWindowFocusedLinux: vi.fn(() => null),
  isOwnProcessForeground: vi.fn(() => false),
  restoreWarframeFocus: vi.fn(() => true),
}));
// hoisted: vi.mock factories run before top-level consts are initialised.
const { logInfo } = vi.hoisted(() => ({ logInfo: vi.fn() }));
vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: (...args: unknown[]) => logInfo(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    time: vi.fn(),
    timeEnd: vi.fn(),
  }),
}));

import {
  applyOverlayZOrder,
  canRaiseOverlayWindows,
  foregroundReadDue,
  registerZOrderSubscriber,
  returnFocusToWarframe,
  syncOverlayWindowZOrder,
  syncUnfocusHide,
  unfocusHideFocused,
} from "../../ipc/overlay/zOrder";
import * as warframeStatus from "../../services/warframeStatus";
import ctx from "../../ipc/context";

beforeEach(() => {
  vi.mocked(warframeStatus.isWindowTopmost).mockReset().mockReturnValue(null);
  logInfo.mockClear();
  ctx.overlayWindow =
    ctx.plannerOverlayWindow =
    ctx.rivenOverlayLeftWindow =
    ctx.rivenOverlayRightWindow =
    ctx.arbiSummaryWindow =
    ctx.tradeNotificationWindow =
      null;
  vi.mocked(warframeStatus.isWarframeOrWindowForeground).mockReset().mockReturnValue(false);
});

function fakeWindow(alwaysOnTop = false) {
  const win = {
    alwaysOnTop,
    setSkipTaskbar: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn((value: boolean) => {
      win.alwaysOnTop = value;
    }),
    moveTop: vi.fn(),
    isAlwaysOnTop: vi.fn(() => win.alwaysOnTop),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isFocusable: vi.fn(() => true),
    getNativeWindowHandle: vi.fn(() => Buffer.alloc(8)),
  };
  return win;
}

// A compositor that echoes the band and then drops it again before the next
// poll, so every tick looks like a fresh burial.
function fakeFlappingWindow() {
  const win = fakeWindow();
  win.isAlwaysOnTop.mockImplementation(() => {
    const reported = win.alwaysOnTop;
    win.alwaysOnTop = false;
    return reported;
  });
  return win;
}

// A compositor with no _NET_WM_STATE_ABOVE support never reports the band back,
// so setAlwaysOnTop(true) leaves isAlwaysOnTop() false forever.
function fakeWindowWithoutAboveSupport() {
  const win = fakeWindow();
  win.setAlwaysOnTop.mockImplementation((value: boolean) => {
    if (!value) win.alwaysOnTop = false;
  });
  return win;
}

type FakeWindow = ReturnType<typeof fakeWindow>;
const asWindow = (win: FakeWindow) => win as unknown as Parameters<typeof applyOverlayZOrder>[0];
const apply = (win: FakeWindow, focused: boolean, platform?: typeof process.platform) =>
  applyOverlayZOrder(asWindow(win), focused, platform);

function fakeController(visible = true, hideDueIn: number | null = null) {
  return {
    isOverlayWindowVisible: vi.fn(() => visible),
    overlayHideDueIn: vi.fn(() => hideDueIn),
    setVisible: (next: boolean) => {
      visible = next;
    },
  };
}

const sync = (
  controller: ReturnType<typeof fakeController>,
  win: FakeWindow,
  focused: boolean,
  platform: typeof process.platform,
) => syncOverlayWindowZOrder(controller, asWindow(win), focused, platform);

describe("overlay foreground guard", () => {
  it("checks only visible, focusable overlay handles", () => {
    const planner = fakeWindow();
    const passiveReward = fakeWindow();
    passiveReward.isFocusable.mockReturnValue(false);
    const hiddenRiven = fakeWindow();
    hiddenRiven.isVisible.mockReturnValue(false);
    ctx.plannerOverlayWindow = asWindow(planner);
    ctx.overlayWindow = asWindow(passiveReward);
    ctx.rivenOverlayLeftWindow = asWindow(hiddenRiven);
    vi.mocked(warframeStatus.isWarframeOrWindowForeground).mockReturnValue(true);

    expect(canRaiseOverlayWindows("win32")).toBe(true);
    expect(warframeStatus.isWarframeOrWindowForeground).toHaveBeenCalledWith([
      planner.getNativeWindowHandle(),
    ]);
  });

  it("does not raise when another app has focus or foreground is unknown", () => {
    for (const foreground of [false, null]) {
      vi.mocked(warframeStatus.isWarframeOrWindowForeground).mockReturnValue(foreground);
      expect(canRaiseOverlayWindows("win32")).toBe(false);
    }
    expect(canRaiseOverlayWindows("linux")).toBe(true);
  });
});

describe("focus hand-back to the game", () => {
  it("accepts every live overlay as the holder, blank or passive ones included", () => {
    const windows = [0, 1, 2, 3, 4, 5].map((index) => {
      const win = fakeWindow();
      win.getNativeWindowHandle.mockReturnValue(Buffer.from([index, 0, 0, 0, 0, 0, 0, 0]));
      win.isVisible.mockReturnValue(false);
      win.isFocusable.mockReturnValue(false);
      return win;
    });
    const destroyed = fakeWindow();
    destroyed.isDestroyed.mockReturnValue(true);
    ctx.overlayWindow = asWindow(windows[0]);
    ctx.plannerOverlayWindow = asWindow(windows[1]);
    ctx.rivenOverlayLeftWindow = asWindow(windows[2]);
    ctx.rivenOverlayRightWindow = asWindow(destroyed);
    ctx.arbiSummaryWindow = asWindow(windows[4]);
    ctx.tradeNotificationWindow = asWindow(windows[5]);

    expect(returnFocusToWarframe()).toBe(true);
    expect(warframeStatus.restoreWarframeFocus).toHaveBeenCalledExactlyOnceWith(
      [0, 1, 2, 4, 5].map((index) => windows[index].getNativeWindowHandle()),
    );
  });
});

// Pinned to win32: the suite runs on ubuntu in CI, where an unpinned call would
// silently take the linux branch and stop testing the WS_EX_TOPMOST gate.
describe("applyOverlayZOrder on Windows", () => {
  it("raises a window that is not already on top", () => {
    const win = fakeWindow();

    apply(win, true, "win32");

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  // Re-applying the taskbar flag is what re-activated the window and stole focus
  // from the game, so no branch may touch it.
  it("never touches the taskbar flag on any branch", () => {
    for (const platform of ["win32", "linux"] as Array<typeof process.platform>) {
      for (const [alreadyOnTop, focused] of [
        [false, true],
        [true, true],
        [false, false],
        [true, false],
      ] as Array<[boolean, boolean]>) {
        const win = fakeWindow(alreadyOnTop);
        apply(win, focused, platform);
        expect(win.setSkipTaskbar).not.toHaveBeenCalled();
      }
    }
  });

  // moveTop() on an already-raised window pulls it into the foreground, which
  // unfocuses the game and flips the next poll - the loop that fed itself.
  it("does not re-raise on every poll while the game stays focused", () => {
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, true, "win32");
    apply(win, true, "win32");

    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  it("drops always-on-top once the game loses focus", () => {
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, false, "win32");

    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(false);
  });

  // Overlays are raised outside this module too (the unlock hotkey re-asserts
  // always-on-top). A remembered state missed those and skipped the drop,
  // stranding the overlay above every other app until the game refocused.
  it("still drops a window raised by someone else", () => {
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, false, "win32");
    win.alwaysOnTop = true; // keepOverlayAboveGame, outside this module
    apply(win, false, "win32");

    expect(win.isAlwaysOnTop()).toBe(false);
  });

  it("leaves an unfocused window that is already down alone", () => {
    const win = fakeWindow();

    apply(win, false, "win32");

    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("raises when the OS says the band is gone though the cache disagrees", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(false);
    const win = fakeWindow(true);

    apply(win, true, "win32");

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  it("skips the raise while the OS confirms the window is topmost", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(true);
    const win = fakeWindow(false);

    apply(win, true, "win32");

    expect(win.moveTop).not.toHaveBeenCalled();
  });

  // The remembered raise is linux-only; Windows keeps re-asserting whenever the
  // live ex-style says the window fell out of the topmost band.
  it("keeps re-raising every poll while the live style says not topmost", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(false);
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, true, "win32");
    apply(win, true, "win32");

    expect(win.moveTop).toHaveBeenCalledTimes(3);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(3);
  });
});

describe("applyOverlayZOrder on linux", () => {
  // niri via xwayland-satellite never reports _NET_WM_STATE_ABOVE back, so the
  // isAlwaysOnTop() gate never closed and the poll restacked the overlay over
  // the fullscreen game every 2s. This asserts the restack stops regardless.
  it("stops re-raising even when the wm never reports always-on-top", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, true, "linux");
    apply(win, true, "linux");

    expect(win.isAlwaysOnTop()).toBe(false);
    expect(win.moveTop).toHaveBeenCalledTimes(1);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(win.setAlwaysOnTop).toHaveBeenCalledTimes(1);
  });

  // The drift path exists to answer a wm-reported burial. A wm that keeps
  // dropping the band it was just given is flapping, so its answer stops
  // counting once the budget is spent.
  it("stops trusting a wm that drops the band it just re-asserted", () => {
    const win = fakeFlappingWindow();

    for (let tick = 0; tick < 6; tick += 1) apply(win, true, "linux");
    const settled = win.moveTop.mock.calls.length;
    for (let tick = 0; tick < 10; tick += 1) apply(win, true, "linux");

    expect(settled).toBe(4);
    expect(win.moveTop).toHaveBeenCalledTimes(4);
  });

  it("does not read the win32 topmost style", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, true, "linux");

    expect(win.getNativeWindowHandle).not.toHaveBeenCalled();
    expect(warframeStatus.isWindowTopmost).not.toHaveBeenCalled();
  });

  // One support line per process, not one per raise: the log is there to say the
  // linux path ran, and a per-tick line would be the noise it replaced.
  it("names the linux raise once per process", () => {
    apply(fakeWindowWithoutAboveSupport(), true, "linux");
    logInfo.mockClear();
    const later = fakeWindowWithoutAboveSupport();

    apply(later, true, "linux");
    apply(later, true, "linux");

    expect(logInfo).not.toHaveBeenCalled();
  });

  it("drops the band on unfocus though the wm never confirmed it", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, false, "linux");

    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(false);
  });

  it("re-applies once the desired state drifts back", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, false, "linux");
    apply(win, true, "linux");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  it("leaves an unfocused window that was never raised alone", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, false, "linux");

    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });

  // isFocused is only "warframe is running" on linux, so the unraise branch
  // never fires mid-session and the remembered raise alone would strand a
  // buried overlay under the game until the next hide.
  it("raises again after the wm reports the band was dropped", () => {
    const win = fakeWindow();

    apply(win, true, "linux");
    apply(win, true, "linux");
    expect(win.moveTop).toHaveBeenCalledTimes(1);

    win.alwaysOnTop = false; // the game restacked over us

    apply(win, true, "linux");

    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  it("goes quiet again once the wm confirms the re-raise", () => {
    const win = fakeWindow();

    apply(win, true, "linux");
    win.alwaysOnTop = false;
    apply(win, true, "linux");
    apply(win, true, "linux");
    apply(win, true, "linux");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  // A reporting wm answering false took the band away but left the workspace
  // flag and the remembered raise, so the unfocus teardown still has work.
  it("tears the raise down when the wm de-banded before the unfocus", () => {
    const win = fakeWindow();

    apply(win, true, "linux");
    win.alwaysOnTop = false; // the wm dropped the band on its own
    win.setAlwaysOnTop.mockClear();
    win.setVisibleOnAllWorkspaces.mockClear();
    apply(win, false, "linux");

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(false);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(false);
  });

  // The teardown is what clears the remembered raise, so a second unfocus tick
  // has nothing left to undo and must stay silent.
  it("forgets the remembered raise once the unfocus teardown ran", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, false, "linux");
    win.setAlwaysOnTop.mockClear();
    win.setVisibleOnAllWorkspaces.mockClear();
    apply(win, false, "linux");

    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });
});

describe("syncOverlayWindowZOrder", () => {
  it("skips a hidden overlay entirely", () => {
    const win = fakeWindowWithoutAboveSupport();
    const controller = fakeController(false);

    sync(controller, win, true, "linux");

    expect(win.moveTop).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("skips a window whose hide is imminent", () => {
    const win = fakeWindowWithoutAboveSupport();
    const controller = fakeController(true, 1_000);

    sync(controller, win, true, "linux");

    expect(win.moveTop).not.toHaveBeenCalled();
  });

  // The unfocus-hide unmaps the panels; the next map starts unstacked, so the
  // remembered raise has to be dropped with the window or it never comes back.
  it("forgets the remembered raise across a hide so the re-show raises again", () => {
    const win = fakeWindowWithoutAboveSupport();
    const controller = fakeController(true);

    sync(controller, win, true, "linux");
    sync(controller, win, true, "linux");
    expect(win.moveTop).toHaveBeenCalledTimes(1);

    controller.setVisible(false);
    sync(controller, win, true, "linux");
    controller.setVisible(true);
    sync(controller, win, true, "linux");
    sync(controller, win, true, "linux");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  // The 2s poll is the only thing still running once the overlay is up, so it
  // has to be the one that rescues a window the game buried.
  it("rescues a visible linux overlay the wm de-banded while the game runs", () => {
    const win = fakeWindow();
    const controller = fakeController(true);

    sync(controller, win, true, "linux");
    sync(controller, win, true, "linux");
    expect(win.moveTop).toHaveBeenCalledTimes(1);

    win.alwaysOnTop = false;
    sync(controller, win, true, "linux");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  // The drift budget is spent per show. A hide resets the drift budget so the
  // next show gets the full allowance against the same flapping wm.
  it("gives a re-shown overlay the full drift budget again", () => {
    const win = fakeFlappingWindow();
    const controller = fakeController(true);

    for (let tick = 0; tick < 10; tick += 1) sync(controller, win, true, "linux");
    const beforeHide = win.moveTop.mock.calls.length;

    controller.setVisible(false);
    sync(controller, win, true, "linux");
    controller.setVisible(true);
    for (let tick = 0; tick < 10; tick += 1) sync(controller, win, true, "linux");

    expect(beforeHide).toBe(4);
    expect(win.moveTop).toHaveBeenCalledTimes(8);
  });

  it("keeps the Windows poll re-asserting on every visible tick", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(false);
    const win = fakeWindow();
    const controller = fakeController(true);

    sync(controller, win, true, "win32");
    sync(controller, win, true, "win32");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });
});

describe("foreground read rate", () => {
  it("reads every tick on win32 and once a second on linux", () => {
    expect(foregroundReadDue("win32", 0)).toBe(true);
    expect(foregroundReadDue("darwin", 0)).toBe(true);
    expect(foregroundReadDue("linux", 250)).toBe(false);
    expect(foregroundReadDue("linux", 750)).toBe(false);
    expect(foregroundReadDue("linux", 1000)).toBe(true);
  });
});

// Last in the file: registering a subscriber starts intervals nothing stops again.
describe("alt-tab response", () => {
  it("syncs on the flip and hands the subscriber its own foreground read", async () => {
    vi.useFakeTimers();
    const sync = vi.fn();
    vi.mocked(warframeStatus.getStatus).mockResolvedValue({
      isOpen: true,
      isFocused: false,
      processRunning: true,
      focusedProcessName: "explorer",
      focusedWindowBounds: null,
      focusedDisplayId: null,
      checkedAt: 0,
    } as never);
    const foreground = vi.mocked(warframeStatus.isWarframeForegroundNow);
    foreground.mockReturnValue(true);

    registerZOrderSubscriber({ isActive: () => true, sync });

    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).not.toHaveBeenCalled();

    foreground.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sync).toHaveBeenCalledWith(false, false);
    expect(warframeStatus.getStatus).toHaveBeenCalledWith({
      needBounds: false,
      force: true,
      keepProcessSample: true,
    });

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

function fakeUnfocusController(visible: boolean) {
  const state = { visible, hiddenByUnfocus: false };
  return {
    state,
    hideForUnfocus: vi.fn(() => {
      if (!state.visible) return false;
      state.visible = false;
      state.hiddenByUnfocus = true;
      return true;
    }),
    restoreAfterUnfocus: vi.fn(() => {
      if (!state.hiddenByUnfocus) return false;
      state.hiddenByUnfocus = false;
      state.visible = true;
      return true;
    }),
  };
}

describe("unfocusHideFocused", () => {
  it("trusts the status poll on Windows", () => {
    expect(unfocusHideFocused(false, true, "win32")).toBe(false);
    expect(unfocusHideFocused(true, false, "win32")).toBe(true);
  });

  it("uses the direct foreground read on linux and treats unknowable as focused", () => {
    expect(unfocusHideFocused(true, false, "linux")).toBe(false);
    vi.mocked(warframeStatus.isWarframeWindowFocusedLinux).mockReturnValue(null);
    expect(unfocusHideFocused(true, null, "linux")).toBe(true);
    vi.mocked(warframeStatus.isWarframeWindowFocusedLinux).mockReturnValue(false);
    expect(unfocusHideFocused(true, null, "linux")).toBe(false);
  });
});

describe("syncUnfocusHide", () => {
  it("hides visible overlays when the game loses focus and restores them on refocus", () => {
    vi.mocked(warframeStatus.isOwnProcessForeground).mockReturnValue(false);
    const a = fakeUnfocusController(true);
    const b = fakeUnfocusController(false);

    expect(syncUnfocusHide("test", [a, b], false, null, "win32")).toBe(false);
    expect(a.state.visible).toBe(false);
    expect(b.hideForUnfocus).toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith("[ZOrder] test hidden - Warframe unfocused");

    expect(syncUnfocusHide("test", [a, b], true, null, "win32")).toBe(true);
    expect(a.state.visible).toBe(true);
    expect(b.state.visible).toBe(false);
    expect(logInfo).toHaveBeenCalledWith("[ZOrder] test restored - Warframe refocused");
  });

  it("keeps overlays up while WFHelper's own window is in front", () => {
    vi.mocked(warframeStatus.isOwnProcessForeground).mockReturnValue(true);
    const a = fakeUnfocusController(true);

    expect(syncUnfocusHide("test", [a], false, null, "win32")).toBe(false);
    expect(a.hideForUnfocus).not.toHaveBeenCalled();
    expect(a.state.visible).toBe(true);
    vi.mocked(warframeStatus.isOwnProcessForeground).mockReturnValue(false);
  });
});
