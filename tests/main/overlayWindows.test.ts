import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { OVERLAY_CONTENT_VISIBLE } from "../../config/shared/ipcChannels";

import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
  moveOverlayWindowBy,
  moveWindowBy,
} from "../../ipc/overlay/windows";
import type {
  OverlaySavedWindowBounds,
  OverlaySettings,
  OverlayWindowKey,
} from "../../config/runtime/overlaySettings";

function createController(overlaySettings: Record<string, unknown> = {}) {
  const display = {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };

  return createOverlayWindowsController({
    app: { getAppPath: () => "D:\\app" } as unknown as typeof import("electron").app,
    BrowserWindow: class {} as unknown as typeof import("electron").BrowserWindow,
    screen: {
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      getCursorScreenPoint: () => ({ x: 960, y: 540 }),
      getDisplayNearestPoint: () => display,
    } as unknown as typeof import("electron").screen,
    ctx: {
      overlayWindow: null,
      overlaySettings: overlaySettings as OverlaySettings,
      overlayInteractiveMode: false,
    },
    log: { warn: () => {}, info: () => {} },
    hardenBrowserWindowNavigation: () => {},
    overlayWindowFile: "D:\\app\\renderer\\overlay.html",
    windowStateKey: "reward",
  });
}

describe("createOverlayWindowsController", () => {
  it("anchors reward overlays below the detected reward band", () => {
    const controller = createController();

    const bounds = controller.getOverlayBoundsForActiveDisplay({
      sourceDisplayId: "1",
      bandTopRatio: 0.38,
      bandBottomRatio: 0.74,
    });

    expect(bounds.y).toBe(842);
  });

  it("treats null band ratios as missing anchor metadata", () => {
    const controller = createController();

    const bounds = controller.getOverlayBoundsForActiveDisplay({
      sourceDisplayId: "1",
      bandTopRatio: null,
      bandBottomRatio: null,
    });

    expect(bounds.y).toBe(605);
  });

  it("applies the user overlay scale to window dimensions", () => {
    const controller = createController({ overlayScale: 1.25 });

    const bounds = controller.getOverlayBoundsForActiveDisplay();

    expect(bounds.width).toBe(1225);
    expect(bounds.height).toBe(175);
  });

  it("uses saved manual positions when present", () => {
    const controller = createController({
      overlayWindowBounds: {
        reward: { x: 250, y: 160, displayId: "1" },
      },
    });

    const bounds = controller.getOverlayBoundsForActiveDisplay({
      sourceDisplayId: "1",
      bandTopRatio: 0.38,
    });

    expect(bounds.x).toBe(250);
    expect(bounds.y).toBe(160);
  });
});

function createWindowTypeProbe(
  platform: typeof process.platform,
  windowOptions: { transparent?: boolean; backgroundColor?: string } = {},
) {
  const captured: Array<Record<string, unknown>> = [];
  const display = {
    id: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };

  class FakeBrowserWindow {
    webContents = {
      id: 1,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomFactor: vi.fn(),
      isLoadingMainFrame: () => false,
      isCrashed: () => false,
    };

    constructor(options: Record<string, unknown>) {
      captured.push(options);
    }

    loadFile() {
      return Promise.resolve();
    }
    on() {}
    setBounds() {}
    setAspectRatio() {}
    getBounds() {
      return { x: 0, y: 0, width: 100, height: 100 };
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return false;
    }
  }

  const controller = createOverlayWindowsController({
    app: { getAppPath: () => "D:\\app" } as unknown as typeof import("electron").app,
    BrowserWindow: FakeBrowserWindow as unknown as typeof import("electron").BrowserWindow,
    screen: {
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      getCursorScreenPoint: () => ({ x: 960, y: 540 }),
      getDisplayNearestPoint: () => display,
    } as unknown as typeof import("electron").screen,
    ctx: {
      overlayWindow: null,
      overlaySettings: {} as OverlaySettings,
      overlayInteractiveMode: false,
    },
    log: { warn: () => {}, info: () => {} },
    hardenBrowserWindowNavigation: () => {},
    overlayWindowFile: "D:\\app\\renderer\\overlay.html",
    platform,
    ...windowOptions,
  });

  return { controller, captured };
}

describe("overlay window type", () => {
  it("maps overlays as toolbar windows on linux so the game keeps focus", () => {
    const { controller, captured } = createWindowTypeProbe("linux");

    controller.createOverlayWindow({ show: false });

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("toolbar");
    expect(captured[0].focusable).toBe(false);
  });

  it("keeps the default window type off linux", () => {
    const { controller, captured } = createWindowTypeProbe("win32");

    controller.createOverlayWindow({ show: false });

    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("type");
  });
});

describe("overlay window transparency", () => {
  const opaqueRequest = { transparent: false, backgroundColor: "#060a12" };

  it("makes an opaque-requested overlay transparent on linux", () => {
    const { controller, captured } = createWindowTypeProbe("linux", opaqueRequest);

    controller.createOverlayWindow({ show: false });

    // Only a transparent window can blank instead of unmap on native Wayland.
    expect(captured[0].transparent).toBe(true);
    expect(captured[0].backgroundColor).toBeUndefined();
  });

  it("keeps the requested opaque window off linux", () => {
    const { controller, captured } = createWindowTypeProbe("win32", opaqueRequest);

    controller.createOverlayWindow({ show: false });

    expect(captured[0].transparent).toBe(false);
    expect(captured[0].backgroundColor).toBe("#060a12");
  });

  it("leaves an already transparent overlay alone off linux", () => {
    const { controller, captured } = createWindowTypeProbe("win32");

    controller.createOverlayWindow({ show: false });

    expect(captured[0].transparent).toBe(true);
    expect(captured[0].backgroundColor).toBeUndefined();
  });
});

describe("first-load zoom", () => {
  it("re-applies the display base zoom when the renderer signals ready", () => {
    // Short edge 720 puts the base zoom at 0.8, so a pristine 1.0 is visible.
    const display = {
      id: 1,
      workArea: { x: 0, y: 0, width: 1280, height: 720 },
    };

    class FakeZoomWindow {
      webContents = {
        id: 1,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomFactor: vi.fn(),
        isLoadingMainFrame: () => false,
        isCrashed: () => false,
      };

      showInactive() {}
      loadFile() {
        return Promise.resolve();
      }
      on() {}
      setBounds() {}
      setAspectRatio() {}
      getBounds() {
        return { x: 0, y: 0, width: 336, height: 512 };
      }
      isDestroyed() {
        return false;
      }
      isVisible() {
        return false;
      }
    }

    const ctx = {
      overlayWindow: null,
      overlaySettings: {} as OverlaySettings,
      overlayInteractiveMode: false,
    };
    const controller = createOverlayWindowsController({
      app: { getAppPath: () => "D:\\app" } as unknown as typeof import("electron").app,
      BrowserWindow: FakeZoomWindow as unknown as typeof import("electron").BrowserWindow,
      screen: {
        getPrimaryDisplay: () => display,
        getAllDisplays: () => [display],
        getCursorScreenPoint: () => ({ x: 640, y: 360 }),
        getDisplayNearestPoint: () => display,
        getDisplayMatching: () => display,
      } as unknown as typeof import("electron").screen,
      ctx,
      log: { warn: () => {}, info: () => {} },
      hardenBrowserWindowNavigation: () => {},
      overlayWindowFile: "D:\\app\\renderer\\riven-overlay.html",
      windowWidth: 420,
      windowHeight: 640,
      platform: "win32",
    });

    controller.createOverlayWindow({ show: false });
    const win = ctx.overlayWindow as unknown as FakeZoomWindow;
    // The zoom set while loadFile is in flight is reset by the navigation commit.
    win.webContents.setZoomFactor.mockClear();

    controller.markRendererReady(1);

    expect(win.webContents.setZoomFactor).toHaveBeenCalledWith(0.8);
  });
});

function createPresentationProbe(options: {
  platform: typeof process.platform;
  nativeWayland: boolean;
  transparent?: boolean;
  neverClickThrough?: boolean;
  tiling?: boolean;
  windowTitle?: string;
  placeOnGameOutput?: (title: string) => Promise<boolean>;
  createPresentation?: (options: unknown) => unknown;
  windowStateKey?: OverlayWindowKey;
  persistBoundsWhenPassive?: boolean;
  onWindowBoundsChanged?: (
    key: OverlayWindowKey,
    bounds: OverlaySavedWindowBounds,
    scale?: number,
  ) => void;
}) {
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const windows: FakePresentationWindow[] = [];

  class FakePresentationWindow {
    webContents = {
      id: 1,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomFactor: vi.fn(),
      isLoadingMainFrame: () => false,
      isCrashed: () => false,
    };

    visible = false;
    destroyed = false;
    options: { webPreferences: { offscreen?: boolean } };

    constructor(options: { webPreferences: { offscreen?: boolean } }) {
      this.options = options;
      windows.push(this);
    }

    showInactive = vi.fn(() => {
      this.visible = true;
    });
    show = vi.fn(() => {
      this.visible = true;
    });
    setTitle = vi.fn();

    hide = vi.fn(() => {
      this.visible = false;
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    isVisible = vi.fn(() => this.visible);
    isDestroyed = vi.fn(() => this.destroyed);
    moveTop = vi.fn();
    focus = vi.fn();
    blur = vi.fn();
    setFocusable = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setSkipTaskbar = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    setBounds = vi.fn();
    setPosition = vi.fn();
    setAspectRatio = vi.fn();
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 }));
    on = vi.fn();
    once = vi.fn();
    loadFile = vi.fn(() => Promise.resolve());
  }

  const ctx = {
    overlayWindow: null,
    overlaySettings: {} as OverlaySettings,
    overlayInteractiveMode: false,
  };

  const logWarn = vi.fn();

  const controller = createOverlayWindowsController({
    app: { getAppPath: () => "D:\\app" } as unknown as typeof import("electron").app,
    BrowserWindow: FakePresentationWindow as unknown as typeof import("electron").BrowserWindow,
    screen: {
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      getCursorScreenPoint: () => ({ x: 960, y: 540 }),
      getDisplayNearestPoint: () => display,
    } as unknown as typeof import("electron").screen,
    ctx,
    log: { warn: logWarn, info: () => {} },
    hardenBrowserWindowNavigation: () => {},
    overlayWindowFile: "D:\\app\\renderer\\overlay.html",
    transparent: options.transparent !== false,
    neverClickThrough: options.neverClickThrough === true,
    platform: options.platform,
    isNativeWayland: () => options.nativeWayland,
    isTilingCompositor: () => options.tiling === true,
    windowTitle: options.windowTitle,
    placeOnGameOutput: options.placeOnGameOutput,
    createPresentation: options.createPresentation as never,
    windowStateKey: options.windowStateKey,
    persistBoundsWhenPassive: options.persistBoundsWhenPassive === true,
    onWindowBoundsChanged: options.onWindowBoundsChanged,
  });

  const contentEvents = (win: FakePresentationWindow) =>
    win.webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CONTENT_VISIBLE);

  return { controller, windows, ctx, contentEvents, logWarn };
}

/** Fire a window event the controller subscribed to; the fake only records them. */
function fireWindowEvent(win: { on: Mock }, event: string): void {
  for (const [name, handler] of win.on.mock.calls) {
    if (name === event) (handler as () => void)();
  }
}

/** Same, for the handlers that take an event object. */
function fireWindowEventWith(win: { on: Mock }, event: string, arg: unknown): void {
  for (const [name, handler] of win.on.mock.calls) {
    if (name === event) (handler as (value: unknown) => void)(arg);
  }
}

const shownLines = (logWarn: Mock): number =>
  logWarn.mock.calls.filter(([line]) => String(line).includes("shown existing window")).length;

describe("re-entrant show", () => {
  it("puts an overlay up once when one trigger creates it twice", () => {
    const probe = createPresentationProbe({ platform: "win32", nativeWayland: false });
    // The route creates the window, then the feature controller creates it
    // again with the anchor it resolved. Both reach createOverlayWindow.
    probe.controller.createOverlayWindow();
    probe.controller.createOverlayWindow();

    expect(probe.windows).toHaveLength(1);
    expect(probe.windows[0].isVisible()).toBe(true);
    expect(shownLines(probe.logWarn)).toBe(0);
  });

  it("still shows an overlay that was hidden since the last create", () => {
    const probe = createPresentationProbe({ platform: "win32", nativeWayland: false });
    probe.controller.createOverlayWindow();
    probe.controller.markRendererReady(1);
    probe.controller.hideOverlayWindow();
    const win = probe.windows[0];
    const showsWhileHidden = win.showInactive.mock.calls.length;

    probe.controller.createOverlayWindow();

    const shown = probe.windows[probe.windows.length - 1];
    // Windows rebuilds a hidden transparent overlay, so the shown window can be
    // a fresh one; either way something has to come back up.
    expect(shown.isVisible()).toBe(true);
    if (shown === win) expect(win.showInactive.mock.calls.length).toBeGreaterThan(showsWhileHidden);
  });
});

describe("keep-mapped presentation mode (native Wayland)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates on native wayland, including the panels that ask to be opaque", () => {
    const cases = [
      { platform: "win32" as const, nativeWayland: false, keepMapped: false },
      { platform: "win32" as const, nativeWayland: false, transparent: false, keepMapped: false },
      { platform: "linux" as const, nativeWayland: false, keepMapped: false },
      // Planner, riven and arbi request an opaque window; linux overrides that.
      { platform: "linux" as const, nativeWayland: true, transparent: false, keepMapped: true },
      { platform: "linux" as const, nativeWayland: true, keepMapped: true },
      // niri leaves a blanked window on screen still taking clicks, so there the
      // overlay has to unmap for real however transparent it is.
      { platform: "linux" as const, nativeWayland: true, tiling: true, keepMapped: false },
      {
        platform: "linux" as const,
        nativeWayland: true,
        transparent: false,
        tiling: true,
        keepMapped: false,
      },
    ];
    for (const testCase of cases) {
      const probe = createPresentationProbe(testCase);
      probe.controller.createOverlayWindow();
      probe.controller.markRendererReady(1);
      probe.controller.hideOverlayWindow();
      const win = probe.windows[0];
      expect(win.hide).toHaveBeenCalledTimes(testCase.keepMapped ? 0 : 1);
      expect(probe.contentEvents(win).length > 0).toBe(testCase.keepMapped);
    }
  });

  it("shows a new window before raising it", () => {
    // moveTop() un-hides a hidden window on Windows, so raising first made
    // moveTop the call that revealed the overlay - without the inactive part,
    // which handed it the foreground and unfocused the game on every open.
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    const win = windows[0];

    expect(win.showInactive).toHaveBeenCalled();
    expect(win.moveTop).toHaveBeenCalled();
    expect(win.showInactive.mock.invocationCallOrder[0]).toBeLessThan(
      win.moveTop.mock.invocationCallOrder[0],
    );
  });

  it("never unmaps or re-maps after the first show", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    expect(win.showInactive).toHaveBeenCalledTimes(1);

    controller.hideOverlayWindow();
    controller.createOverlayWindow();
    controller.hideOverlayWindow();
    controller.showOverlayWindowInactive();

    expect(windows).toHaveLength(1);
    expect(win.hide).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.moveTop.mock.calls.length).toBeGreaterThan(1);
  });

  it("hides by blanking content and going click-through", () => {
    const { controller, windows, contentEvents } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    win.setIgnoreMouseEvents.mockClear();

    controller.hideOverlayWindow();

    expect(contentEvents(win).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, false]);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(win.isVisible()).toBe(true);

    controller.showOverlayWindowInactive();
    expect(contentEvents(win).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, true]);
  });

  it("tracks logical visibility instead of the OS-visible state", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
    });

    expect(controller.isOverlayWindowVisible()).toBe(false);
    controller.createOverlayWindow();
    controller.markRendererReady(1);
    expect(controller.isOverlayWindowVisible()).toBe(true);

    controller.hideOverlayWindow();
    expect(windows[0].isVisible()).toBe(true);
    expect(controller.isOverlayWindowVisible()).toBe(false);

    controller.createOverlayWindow();
    expect(controller.isOverlayWindowVisible()).toBe(true);
  });

  it("auto-hide uses the logical hide path", () => {
    vi.useFakeTimers();
    const { controller, windows, contentEvents } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    controller.scheduleOverlayAutoHide(500);
    vi.advanceTimersByTime(600);

    const win = windows[0];
    expect(win.hide).not.toHaveBeenCalled();
    expect(contentEvents(win).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, false]);
    expect(controller.isOverlayWindowVisible()).toBe(false);
  });

  it("hiding an interactive window hands focus back", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    controller.setOverlayInteractiveMode(true);
    win.blur.mockClear();

    controller.hideOverlayWindow();

    expect(win.blur).toHaveBeenCalledTimes(1);
    expect(win.setFocusable).toHaveBeenLastCalledWith(false);
  });

  it("interactive mode focuses in and returns to click-through without re-mapping", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];

    controller.setOverlayInteractiveMode(true);
    expect(win.setFocusable).toHaveBeenCalledWith(true);
    expect(win.focus).toHaveBeenCalledTimes(1);

    win.setIgnoreMouseEvents.mockClear();
    controller.setOverlayInteractiveMode(false);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(win.setFocusable).toHaveBeenLastCalledWith(false);
    expect(win.showInactive).toHaveBeenCalledTimes(1);
  });

  it("leaving interactive mode re-raises after the show settles", () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    vi.advanceTimersByTime(5_000);
    controller.setOverlayInteractiveMode(true);

    // An immediate raise loses the race with the focusable flip; only the
    // delayed reassert rescues the window.
    controller.setOverlayInteractiveMode(false);
    win.setAlwaysOnTop.mockClear();
    win.moveTop.mockClear();
    vi.advanceTimersByTime(1_600);

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalled();
  });

  it("a blurred panel re-raises - the focus handoff can strip its topmost band", () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    vi.advanceTimersByTime(5_000);
    win.setAlwaysOnTop.mockClear();
    win.moveTop.mockClear();

    fireWindowEvent(win, "blur");
    vi.advanceTimersByTime(1_600);

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalled();
  });

  it("stacked reassert triggers collapse into one pending raise pair", () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    controller.setOverlayInteractiveMode(true);
    vi.advanceTimersByTime(5_000);
    win.moveTop.mockClear();

    // F7-off schedules a reassert and its blur() fires the listener's too.
    controller.setOverlayInteractiveMode(false);
    fireWindowEvent(win, "blur");
    win.moveTop.mockClear();
    vi.advanceTimersByTime(1_600);

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  it("entering interactive mode re-raises the panel focus() does not rescue", () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    vi.advanceTimersByTime(5_000);

    controller.setOverlayInteractiveMode(true);
    win.setAlwaysOnTop.mockClear();
    win.moveTop.mockClear();
    vi.advanceTimersByTime(1_600);

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalled();
  });

  it("applies the input flags while hidden so the mode cannot desync", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    controller.hideOverlayWindow();
    win.setIgnoreMouseEvents.mockClear();
    win.focus.mockClear();

    controller.setOverlayInteractiveMode(true);

    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(win.setFocusable).toHaveBeenLastCalledWith(true);
    // Nothing on screen yet, so stacking and focus stay untouched.
    expect(win.focus).not.toHaveBeenCalled();
  });

  it("re-asserts the interactive mode when a hidden window is shown again", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    controller.hideOverlayWindow();
    controller.setOverlayInteractiveMode(true);
    win.focus.mockClear();

    controller.showOverlayWindowInactive();

    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a click-through window before it goes interactive on linux", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const stale = windows[0];
    controller.sendOverlayEvent("relic-reward-items", [{ name: "Forma Blueprint" }]);
    expect(stale.setIgnoreMouseEvents).toHaveBeenCalledWith(true);

    controller.setOverlayInteractiveMode(true);

    expect(stale.destroy).toHaveBeenCalledTimes(1);
    expect(windows).toHaveLength(2);
    const fresh = windows[1];
    // The rebuilt window must never have been click-through - X11 cannot undo it.
    expect(fresh.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true);
    expect(fresh.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(fresh.setBounds).toHaveBeenCalledWith(stale.getBounds(), false);

    controller.markRendererReady(1);
    expect(fresh.webContents.send).toHaveBeenCalledWith("relic-reward-items", [
      { name: "Forma Blueprint" },
    ]);
  });

  // destroy() emitting "closed" a tick late would otherwise land after the
  // replacement is registered and tear it down: window on screen, handle null,
  // auto-hide cancelled, nothing left able to close it.
  it("ignores a late closed event from the window the rebuild replaced", () => {
    const { controller, windows, ctx } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    const stale = windows[0];
    controller.setOverlayInteractiveMode(true);
    const fresh = windows[1];
    expect(ctx.overlayWindow).toBe(fresh);

    fireWindowEvent(stale, "closed");

    expect(ctx.overlayWindow).toBe(fresh);
    expect(controller.isOverlayWindowVisible()).toBe(true);
  });

  it("still resets the controller when the live window closes", () => {
    const { controller, windows, ctx } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    expect(ctx.overlayWindow).toBe(windows[0]);

    fireWindowEvent(windows[0], "closed");

    expect(ctx.overlayWindow).toBeNull();
  });

  it("re-asserts click-through after the window is actually mapped", async () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    const win = windows[0];
    win.setIgnoreMouseEvents.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);

    // X11 loses the empty input region when it is set before the map.
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
  });

  it("clears the input shape before re-setting it on linux", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    const win = windows[0];
    win.setIgnoreMouseEvents.mockClear();
    controller.setOverlayInteractiveMode(false);

    // An identical shape is invisible to the compositor; the clear makes it a change.
    expect(win.setIgnoreMouseEvents.mock.calls).toEqual([[false], [true]]);
  });

  it("does not re-assert click-through while interactive", async () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    controller.setOverlayInteractiveMode(true);
    const fresh = windows[windows.length - 1];
    fresh.setIgnoreMouseEvents.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fresh.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true);
  });

  it("re-arms a pending auto-hide across the interactive rebuild", async () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    controller.scheduleOverlayAutoHide(3_000);
    controller.setOverlayInteractiveMode(true);
    const fresh = windows[windows.length - 1];

    await vi.advanceTimersByTimeAsync(3_500);

    expect(fresh.hide).toHaveBeenCalled();
  });

  it("keeps the window on a native-Wayland tiling compositor going interactive", () => {
    // Keep-mapped mode is off on niri and friends, which is not a reason to
    // rebuild: only X11 refuses to hand the input shape back.
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      tiling: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);

    controller.setOverlayInteractiveMode(true);

    expect(windows).toHaveLength(1);
    expect(win.destroy).not.toHaveBeenCalled();
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  it("keeps interactive mode on the same window off linux", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);

    controller.setOverlayInteractiveMode(true);

    expect(windows).toHaveLength(1);
    expect(windows[0].destroy).not.toHaveBeenCalled();
  });

  it("stops a blanked never-click-through window from eating clicks", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      transparent: false,
      neverClickThrough: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    win.setIgnoreMouseEvents.mockClear();

    // The arbi summary stays mapped while blank, so it would swallow every
    // click over the game unless the shape is dropped with the content.
    controller.hideOverlayWindow();
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);

    controller.showOverlayWindowInactive();
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  it("never makes a never-click-through window ignore the mouse", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
      neverClickThrough: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    controller.setOverlayInteractiveMode(false);

    expect(windows).toHaveLength(1);
    expect(windows[0].setIgnoreMouseEvents).not.toHaveBeenCalledWith(true);
  });

  it("keeps the destroy-recreate re-show workaround on Windows only", () => {
    const { controller, windows, contentEvents } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const first = windows[0];

    controller.hideOverlayWindow();
    expect(first.hide).toHaveBeenCalledTimes(1);

    controller.createOverlayWindow();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(windows).toHaveLength(2);
    expect(contentEvents(first)).toHaveLength(0);
    expect(contentEvents(windows[1])).toHaveLength(0);

    controller.showOverlayWindowInactive();
    expect(windows[1].showInactive.mock.calls.length).toBeGreaterThan(0);
  });

  // Rebuilding on X11 would map a fresh window per popup, which is the focus
  // steal keep-mapped mode exists to avoid; the black box is a Windows artefact.
  it("re-shows a transparent linux window instead of rebuilding it", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];

    controller.hideOverlayWindow();
    controller.createOverlayWindow();

    expect(win.destroy).not.toHaveBeenCalled();
    expect(windows).toHaveLength(1);
    expect(win.showInactive.mock.calls.length).toBeGreaterThan(1);
  });

  it("passive interactive-mode exit still re-shows off the wayland mode", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    const showsBefore = win.showInactive.mock.calls.length;

    controller.setOverlayInteractiveMode(true);
    controller.setOverlayInteractiveMode(false);

    expect(win.showInactive.mock.calls.length).toBe(showsBefore + 1);
  });
});

describe("show raise reassert", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A re-shown planner landed behind the game and nothing rescued it - the
  // z-order poll deliberately skips windows already always-on-top.
  it("re-raises a re-shown window after the map settles", async () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    controller.hideOverlayWindow();
    controller.showOverlayWindowInactive();
    win.moveTop.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(win.moveTop.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "screen-saver");
  });

  it("does not raise a window that was hidden again before the timer", async () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    controller.showOverlayWindowInactive();
    controller.hideOverlayWindow();
    win.moveTop.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(win.moveTop).not.toHaveBeenCalled();
  });
});

describe("moveWindowBy", () => {
  // Stands in for any window that returns a smaller size than it was handed:
  // a move must not write the size at all, or the overlay shrinks per tick.
  function fakeWindow(bounds: { x: number; y: number; width: number; height: number }) {
    const state = { ...bounds };
    return {
      state,
      getBounds: () => ({ ...state }),
      setPosition: (x: number, y: number) => {
        state.x = x;
        state.y = y;
      },
      setBounds: (next: { x: number; y: number; width: number; height: number }) => {
        state.x = next.x;
        state.y = next.y;
        state.width = next.width - 1;
        state.height = next.height - 1;
      },
    };
  }

  it("moves the window", () => {
    const win = fakeWindow({ x: 100, y: 200, width: 490, height: 344 });

    moveWindowBy(win, 12, -8);

    expect(win.state).toMatchObject({ x: 112, y: 192 });
  });

  it("never changes the size, however many drags it takes", () => {
    const win = fakeWindow({ x: 100, y: 200, width: 490, height: 344 });

    for (let tick = 0; tick < 50; tick += 1) moveWindowBy(win, 3, 0);

    expect(win.state).toMatchObject({ x: 250, width: 490, height: 344 });
  });
});

describe("createOverlayWindowBoundsChangeHandler", () => {
  it("saves bounds and retires the drag hint on live moves, except for the arbi summary", () => {
    const ctx = {
      overlaySettings: { overlayWindowBounds: {} } as unknown as OverlaySettings,
    };
    const save = vi.fn();
    const handler = createOverlayWindowBoundsChangeHandler({ ctx, save });

    handler("arbiSummary", { x: 30, y: 40 });
    expect(ctx.overlaySettings.overlayWindowBounds.arbiSummary).toEqual({ x: 30, y: 40 });
    expect(ctx.overlaySettings.overlayDragHintDismissed).toBeUndefined();

    handler("reward", { x: 10, y: 20, displayId: "1" });
    expect(ctx.overlaySettings.overlayWindowBounds.reward).toEqual({
      x: 10,
      y: 20,
      displayId: "1",
    });
    expect(ctx.overlaySettings.overlayDragHintDismissed).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("writes the per-window scale only when a resize supplies one", () => {
    const ctx = {
      overlaySettings: {
        overlayWindowBounds: {},
        overlayWindowScales: {},
      } as unknown as OverlaySettings,
    };
    const handler = createOverlayWindowBoundsChangeHandler({ ctx, save: vi.fn() });

    handler("reward", { x: 10, y: 20 });
    expect(ctx.overlaySettings.overlayWindowScales.reward).toBeUndefined();

    handler("reward", { x: 10, y: 20 }, 1.25);
    expect(ctx.overlaySettings.overlayWindowScales.reward).toBe(1.25);
  });
});

function createResizeProbe() {
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const saves: Array<{ bounds: OverlaySavedWindowBounds; scale?: number }> = [];
  let currentBounds = { x: 300, y: 400, width: 980, height: 140 };
  const windows: FakeResizableWindow[] = [];

  class FakeResizableWindow {
    webContents = {
      id: 1,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomFactor: vi.fn(),
      isLoadingMainFrame: () => false,
      isCrashed: () => false,
    };

    listeners = new Map<string, () => void>();

    constructor() {
      windows.push(this);
    }

    on = vi.fn((event: string, listener: () => void) => {
      this.listeners.set(event, listener);
    });
    loadFile = vi.fn(() => Promise.resolve());
    setAspectRatio = vi.fn();
    setBounds = vi.fn();
    getBounds = vi.fn(() => currentBounds);
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => false);
    showInactive = vi.fn();
    moveTop = vi.fn();
    hide = vi.fn();
    destroy = vi.fn();
    setSkipTaskbar = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    setFocusable = vi.fn();
    setIgnoreMouseEvents = vi.fn();
  }

  const ctx = {
    overlayWindow: null,
    overlaySettings: {} as OverlaySettings,
    overlayInteractiveMode: true,
  };
  // The real persistence handler, so a saved scale is in place by the time the
  // controller reads it back.
  const persist = createOverlayWindowBoundsChangeHandler({ ctx, save: () => {} });

  const controller = createOverlayWindowsController({
    app: { getAppPath: () => "D:\\app" } as unknown as typeof import("electron").app,
    BrowserWindow: FakeResizableWindow as unknown as typeof import("electron").BrowserWindow,
    screen: {
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      getCursorScreenPoint: () => ({ x: 960, y: 540 }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
    } as unknown as typeof import("electron").screen,
    ctx,
    log: { warn: () => {}, info: () => {} },
    hardenBrowserWindowNavigation: () => {},
    overlayWindowFile: "D:\\app\\renderer\\overlay.html",
    windowStateKey: "reward",
    onWindowBoundsChanged: (key, bounds, scale) => {
      saves.push({ bounds, scale });
      persist(key, bounds, scale);
    },
    platform: "win32",
  });

  vi.useFakeTimers();
  controller.createOverlayWindow({ show: false });
  // Clears the suppression the initial positioning arms.
  vi.advanceTimersByTime(1);

  return {
    saves,
    ctx,
    window: () => windows[windows.length - 1],
    dragEdgeTo: (width: number, height: number) => {
      currentBounds = { ...currentBounds, width, height };
      windows[windows.length - 1].listeners.get("resize")?.();
      vi.advanceTimersByTime(250);
    },
  };
}

describe("overlay resize", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves the scale a dragged edge works out to", () => {
    const probe = createResizeProbe();

    probe.dragEdgeTo(1225, 175);

    expect(probe.saves).toHaveLength(1);
    expect(probe.saves[0].scale).toBe(1.25);
    expect(probe.saves[0].bounds).toMatchObject({ x: 300, y: 400, displayId: "1" });
  });

  it("zooms the content while the drag is still live", () => {
    const probe = createResizeProbe();

    probe.dragEdgeTo(1225, 175);

    expect(probe.window().webContents.setZoomFactor).toHaveBeenLastCalledWith(1.25);
  });

  it("clamps a drag past the scale the settings slider allows", () => {
    const probe = createResizeProbe();

    probe.dragEdgeTo(1880, 268);

    expect(probe.saves[0].scale).toBe(1.5);
  });

  it("scales from the edge that moved when only one of them did", () => {
    const probe = createResizeProbe();

    probe.dragEdgeTo(980, 175);

    expect(probe.saves[0].scale).toBe(1.25);
    expect(probe.window().setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 1225, height: 175 }),
      false,
    );
  });

  it("springs a drag below the smallest scale back to that scale", () => {
    const probe = createResizeProbe();

    probe.dragEdgeTo(500, 71);

    expect(probe.saves[0].scale).toBe(0.75);
    expect(probe.window().setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 735, height: 105 }),
      false,
    );
  });

  it("leaves the scale alone when the size is the one we asked for", () => {
    const probe = createResizeProbe();

    probe.dragEdgeTo(980, 140);

    expect(probe.saves).toHaveLength(0);
  });
});

describe("overlayHideDueIn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function controllerWithWindow() {
    const overlayWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      hide: () => {},
    };
    const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

    return createOverlayWindowsController({
      app: { getAppPath: () => "D:\\app" } as unknown as typeof import("electron").app,
      BrowserWindow: class {} as unknown as typeof import("electron").BrowserWindow,
      screen: {
        getPrimaryDisplay: () => display,
        getAllDisplays: () => [display],
        getCursorScreenPoint: () => ({ x: 960, y: 540 }),
        getDisplayNearestPoint: () => display,
      } as unknown as typeof import("electron").screen,
      ctx: {
        overlayWindow: null,
        overlaySettings: {} as OverlaySettings,
        overlayInteractiveMode: false,
      },
      log: { warn: () => {}, info: () => {} },
      hardenBrowserWindowNavigation: () => {},
      overlayWindowFile: "D:\\app\\renderer\\overlay.html",
      windowStateKey: "reward",
      getOverlayWindow: () =>
        overlayWindow as unknown as InstanceType<typeof import("electron").BrowserWindow>,
    });
  }

  it("reports nothing while no hide is queued", () => {
    expect(controllerWithWindow().overlayHideDueIn()).toBeNull();
  });

  it("counts down instead of flagging the overlay's whole life", () => {
    vi.useFakeTimers();
    const controller = controllerWithWindow();

    controller.scheduleOverlayAutoHide(120_000);
    expect(controller.overlayHideDueIn()).toBeGreaterThan(100_000);

    vi.advanceTimersByTime(119_000);
    expect(controller.overlayHideDueIn()).toBeLessThanOrEqual(1_000);
  });

  it("clears once the hide has fired", () => {
    vi.useFakeTimers();
    const controller = controllerWithWindow();

    controller.scheduleOverlayAutoHide(2_500);
    vi.advanceTimersByTime(3_000);

    expect(controller.overlayHideDueIn()).toBeNull();
  });
});

describe("layer-shell presentation", () => {
  function fakePresentation() {
    return {
      attach: vi.fn(),
      show: vi.fn(async () => true),
      hide: vi.fn(),
      isShowing: vi.fn(() => true),
      setInteractive: vi.fn(),
      applyGeometry: vi.fn(),
    };
  }

  function probeWithLayer(nativeWayland: boolean, platform: typeof process.platform = "linux") {
    const presentation = fakePresentation();
    const createPresentation = vi.fn(() => presentation);
    const probe = createPresentationProbe({
      platform,
      nativeWayland,
      createPresentation,
      windowTitle: "WFHelper Relic Rewards",
    });
    return { ...probe, presentation, createPresentation };
  }

  it("renders offscreen and never maps the window", () => {
    const probe = probeWithLayer(true);

    probe.controller.createOverlayWindow();
    const win = probe.windows[0];

    expect(win.options.webPreferences.offscreen).toBe(true);
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.moveTop).not.toHaveBeenCalled();
    expect(probe.presentation.show).toHaveBeenCalled();
  });

  it("wires the window's paints to a surface of the same size", () => {
    const probe = probeWithLayer(true);

    probe.controller.createOverlayWindow();

    const [window, width, height] = probe.presentation.attach.mock.calls[0];
    expect(window).toBe(probe.windows[0]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  // The window is never OS-visible in this mode, so isVisible() would lie.
  it("tracks visibility logically and drops the surface on hide", () => {
    const probe = probeWithLayer(true);
    probe.controller.createOverlayWindow();

    expect(probe.controller.isOverlayWindowVisible()).toBe(true);

    probe.controller.hideOverlayWindow();

    expect(probe.presentation.hide).toHaveBeenCalled();
    expect(probe.controller.isOverlayWindowVisible()).toBe(false);
    expect(probe.windows[0].hide).not.toHaveBeenCalled();
  });

  // The surface swaps its input region in place, so the rebuild the X11 path
  // needs would only throw away a working surface.
  it("takes clicks by making the surface interactive, not by rebuilding", () => {
    const probe = probeWithLayer(true);
    probe.controller.createOverlayWindow();
    const built = probe.windows.length;

    probe.controller.setOverlayInteractiveMode(true);

    expect(probe.presentation.setInteractive).toHaveBeenLastCalledWith(true);
    expect(probe.windows).toHaveLength(built);
    expect(probe.windows[0].options.webPreferences.offscreen).toBe(true);
  });

  it("hands clicks back to the game when interactive mode is left", () => {
    const probe = probeWithLayer(true);
    probe.controller.createOverlayWindow();
    probe.controller.setOverlayInteractiveMode(true);

    probe.controller.setOverlayInteractiveMode(false);

    expect(probe.presentation.setInteractive).toHaveBeenLastCalledWith(false);
    expect(probe.windows[0].setFocusable).not.toHaveBeenCalled();
  });

  it("opens straight onto a layer surface when interactive mode is already on", () => {
    const probe = probeWithLayer(true);
    probe.controller.setOverlayInteractiveMode(true);

    probe.controller.createOverlayWindow();

    expect(probe.createPresentation).toHaveBeenCalled();
    expect(probe.windows[0].options.webPreferences.offscreen).toBe(true);
  });

  // The arbi summary is clickable without the unlock hotkey, so its surface must
  // take input even though the controller reports passive mode.
  it("gives a never-click-through overlay an input region straight away", () => {
    const presentation = fakePresentation();
    const probe = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      neverClickThrough: true,
      createPresentation: vi.fn(() => presentation),
    });

    probe.controller.createOverlayWindow();

    expect(presentation.setInteractive).toHaveBeenLastCalledWith(true);
  });

  it("leaves an ordinary overlay click-through until asked", () => {
    const probe = probeWithLayer(true);

    probe.controller.createOverlayWindow();

    expect(probe.presentation.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it("drags a layer surface by rewriting the saved spot", () => {
    const saves: OverlaySavedWindowBounds[] = [];
    const presentation = fakePresentation();
    const probe = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      createPresentation: vi.fn(() => presentation),
      windowStateKey: "reward",
      onWindowBoundsChanged: (_key, bounds) => saves.push(bounds),
    });
    probe.controller.createOverlayWindow();
    presentation.applyGeometry.mockClear();
    const win = probe.windows[0];

    moveOverlayWindowBy(win as never, 40, -25);

    // The centred default on a 1920x1080 display, moved by the delta.
    expect(saves).toEqual([{ x: 510, y: 580, displayId: "1" }]);
    expect(presentation.applyGeometry).toHaveBeenCalledTimes(1);
    // The window behind a layer surface is offscreen, so moving it does nothing.
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it("never persists the offscreen window's own resizes in layer mode", () => {
    const saves: OverlaySavedWindowBounds[] = [];
    const probe = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      createPresentation: vi.fn(() => fakePresentation()),
      windowStateKey: "reward",
      persistBoundsWhenPassive: true,
      onWindowBoundsChanged: (_key, bounds) => saves.push(bounds),
    });

    probe.controller.createOverlayWindow();
    const win = probe.windows[0];

    expect(win.on.mock.calls.filter(([event]) => event === "resize")).toEqual([]);
    expect(win.on.mock.calls.filter(([event]) => event === "move")).toEqual([]);
    expect(saves).toEqual([]);
  });

  it("still persists resizes when there is no layer surface", () => {
    const probe = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      createPresentation: () => null,
      windowStateKey: "reward",
      persistBoundsWhenPassive: true,
      onWindowBoundsChanged: () => {},
    });

    probe.controller.createOverlayWindow();

    expect(probe.windows[0].on.mock.calls.filter(([event]) => event === "resize")).toHaveLength(1);
  });

  it("is never built on XWayland or off linux", () => {
    const onXWayland = probeWithLayer(false);
    onXWayland.controller.createOverlayWindow();
    const onWindows = probeWithLayer(false, "win32");
    onWindows.controller.createOverlayWindow();

    expect(onXWayland.createPresentation).not.toHaveBeenCalled();
    expect(onWindows.createPresentation).not.toHaveBeenCalled();
  });

  it("keeps the window path when no layer shell is available", () => {
    const probe = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      createPresentation: () => null,
    });

    probe.controller.createOverlayWindow();

    expect(probe.windows[0].showInactive).toHaveBeenCalled();
  });
});

describe("compositor placement", () => {
  async function probeWithPlacer(
    nativeWayland: boolean,
    placeOnGameOutput: (title: string) => Promise<boolean>,
    platform: typeof process.platform = "linux",
  ) {
    const probe = createPresentationProbe({
      platform,
      nativeWayland,
      windowTitle: "WFHelper Relic Rewards",
      placeOnGameOutput,
    });
    probe.controller.createOverlayWindow();
    await vi.advanceTimersByTimeAsync(2000);
    return probe;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks the compositor for the game's output on native Wayland", async () => {
    const place = vi.fn(async () => true);

    await probeWithPlacer(true, place);

    expect(place).toHaveBeenCalledWith("WFHelper Relic Rewards");
    // A compositor that placed the window is not asked a second time.
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("asks again when the first try lands before the window is mapped", async () => {
    const place = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

    await probeWithPlacer(true, place);

    expect(place).toHaveBeenCalledTimes(2);
  });

  it("gives up rather than asking forever", async () => {
    const place = vi.fn(async () => false);

    await probeWithPlacer(true, place);

    expect(place).toHaveBeenCalledTimes(2);
  });

  it("stays quiet on XWayland and off linux, where setPosition works", async () => {
    const onXWayland = vi.fn(async () => true);
    const onWindows = vi.fn(async () => true);

    await probeWithPlacer(false, onXWayland);
    await probeWithPlacer(false, onWindows, "win32");

    expect(onXWayland).not.toHaveBeenCalled();
    expect(onWindows).not.toHaveBeenCalled();
  });
});

describe("window title", () => {
  it("names the window and holds the name against the page", () => {
    const probe = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
      windowTitle: "WFHelper Relic Rewards",
    });
    probe.controller.createOverlayWindow();
    const win = probe.windows[0];

    expect(win.setTitle).toHaveBeenCalledWith("WFHelper Relic Rewards");
    // Two overlays share one html file, so the page title would collapse them
    // back into one name and no compositor rule could tell them apart.
    const prevented = vi.fn();
    fireWindowEventWith(win, "page-title-updated", { preventDefault: prevented });
    expect(prevented).toHaveBeenCalled();
  });

  it("leaves the title alone when none is configured", () => {
    const probe = createPresentationProbe({ platform: "win32", nativeWayland: false });
    probe.controller.createOverlayWindow();

    expect(probe.windows[0].setTitle).not.toHaveBeenCalled();
  });
});
