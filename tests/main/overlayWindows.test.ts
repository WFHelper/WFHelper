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
      isFocused() {
        return false;
      }
      isFocusable() {
        return false;
      }
      setFocusable() {}
      setIgnoreMouseEvents() {}
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
  placeOnGameOutput?: (title: string, output: string | null) => Promise<boolean>;
  createPresentation?: (options: unknown) => unknown;
  windowStateKey?: OverlayWindowKey;
  persistBoundsWhenPassive?: boolean;
  onWindowBoundsChanged?: (key: OverlayWindowKey, bounds: OverlaySavedWindowBounds) => void;
  canRaise?: () => boolean;
  onPresentationEnd?: () => void;
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
    focused = false;
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
    focus = vi.fn(() => {
      this.focused = true;
    });
    blur = vi.fn(() => {
      this.focused = false;
    });
    isFocused = vi.fn(() => this.focused);
    focusable = false;
    setFocusable = vi.fn((value: boolean) => {
      this.focusable = value;
    });
    isFocusable = vi.fn(() => this.focusable);
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
    canRaise: options.canRaise,
    onPresentationEnd: options.onPresentationEnd,
  });

  const contentEvents = (win: FakePresentationWindow) =>
    win.webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CONTENT_VISIBLE);

  return { controller, windows, ctx, contentEvents, logWarn };
}

function fireWindowEvent(win: { on: Mock }, event: string): void {
  for (const [name, handler] of win.on.mock.calls) {
    if (name === event) (handler as () => void)();
  }
}

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

    probe.controller.createOverlayWindow();

    expect(probe.controller.isOverlayWindowVisible()).toBe(true);
    expect(probe.contentEvents(win).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, true]);
  });
});

describe("keep-mapped presentation mode (Windows and native Wayland)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates for every transparent overlay, opaque panels excepted", () => {
    const cases = [
      { platform: "win32" as const, nativeWayland: false, keepMapped: true },
      { platform: "win32" as const, nativeWayland: false, transparent: false, keepMapped: false },
      { platform: "linux" as const, nativeWayland: false, keepMapped: false },
      { platform: "linux" as const, nativeWayland: true, transparent: false, keepMapped: true },
      { platform: "linux" as const, nativeWayland: true, keepMapped: true },
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

  it.each([
    {
      platform: "win32" as const,
      nativeWayland: false,
      interactive: false,
      neverClickThrough: false,
    },
    {
      platform: "win32" as const,
      nativeWayland: false,
      interactive: true,
      neverClickThrough: false,
    },
    {
      platform: "win32" as const,
      nativeWayland: false,
      interactive: false,
      neverClickThrough: true,
    },
    {
      platform: "linux" as const,
      nativeWayland: true,
      interactive: true,
      neverClickThrough: false,
    },
  ])("reapplies delivered hidden state to a new document on READY: %s", (options) => {
    const { controller, windows, contentEvents, ctx } = createPresentationProbe(options);
    controller.createOverlayWindow();
    controller.markRendererReady(1);
    controller.hideOverlayWindow();
    controller.setOverlayInteractiveMode(options.interactive);
    const win = windows[0];
    win.webContents.send.mockClear();
    win.setIgnoreMouseEvents.mockClear();
    win.setFocusable.mockClear();

    controller.markRendererReady(1);

    expect(contentEvents(win).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, false]);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(win.isFocusable()).toBe(false);
    expect(ctx.overlayInteractiveMode).toBe(options.interactive);
    controller.showOverlayWindowInactive();
    expect(contentEvents(win).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, true]);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(
      !(options.interactive || options.neverClickThrough),
    );
    expect(win.isFocusable()).toBe(false);
  });

  it("hides for unfocus and restores on refocus", () => {
    const { controller, windows, contentEvents } = createPresentationProbe({
      platform: "linux",
      nativeWayland: true,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    expect(controller.hideForUnfocus()).toBe(true);
    expect(controller.isOverlayWindowVisible()).toBe(false);
    expect(controller.isHiddenByUnfocus()).toBe(true);
    expect(contentEvents(windows[0]).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, false]);

    expect(controller.restoreAfterUnfocus()).toBe(true);
    expect(controller.isOverlayWindowVisible()).toBe(true);
    expect(controller.isHiddenByUnfocus()).toBe(false);
    expect(controller.restoreAfterUnfocus()).toBe(false);
  });

  it("does not restore an overlay that was hidden for good meanwhile", () => {
    const { controller } = createPresentationProbe({ platform: "linux", nativeWayland: true });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    controller.hideForUnfocus();
    controller.hideOverlayWindow();

    expect(controller.isHiddenByUnfocus()).toBe(false);
    expect(controller.restoreAfterUnfocus()).toBe(false);
    expect(controller.isOverlayWindowVisible()).toBe(false);
  });

  it("does not restore an overlay whose auto-hide passed while it was unfocused", () => {
    vi.useFakeTimers();
    const { controller } = createPresentationProbe({ platform: "linux", nativeWayland: true });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    controller.scheduleOverlayAutoHide(500);
    controller.hideForUnfocus();
    vi.advanceTimersByTime(600);

    expect(controller.restoreAfterUnfocus()).toBe(false);
    expect(controller.isOverlayWindowVisible()).toBe(false);
  });

  it("leaves an overlay in interactive mode alone on unfocus", () => {
    const { controller, ctx } = createPresentationProbe({ platform: "linux", nativeWayland: true });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    ctx.overlayInteractiveMode = true;

    expect(controller.hideForUnfocus()).toBe(false);
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
    controller.setOverlayInteractiveMode(true, { focus: true });
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

    controller.setOverlayInteractiveMode(true, { focus: true });
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

  it("does not raise over an unrelated foreground window after interaction ends", () => {
    vi.useFakeTimers();
    const canRaise = vi.fn(() => true);
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
      transparent: false,
      canRaise,
    });
    controller.createOverlayWindow();
    const win = windows[0];
    controller.setOverlayInteractiveMode(true);
    vi.advanceTimersByTime(2_000);
    win.focused = false;
    canRaise.mockReturnValue(false);
    win.blur.mockClear();
    win.moveTop.mockClear();
    win.showInactive.mockClear();
    win.setAlwaysOnTop.mockClear();

    fireWindowEvent(win, "blur");
    controller.setOverlayInteractiveMode(false);
    vi.advanceTimersByTime(2_000);

    expect(win.blur).not.toHaveBeenCalled();
    expect(win.moveTop).not.toHaveBeenCalled();
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).not.toHaveBeenCalledWith(true, "screen-saver");
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(false);
  });

  it("rechecks foreground when a delayed raise runs", () => {
    vi.useFakeTimers();
    const canRaise = vi.fn(() => true);
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
      canRaise,
    });
    controller.createOverlayWindow();
    const win = windows[0];
    win.moveTop.mockClear();
    canRaise.mockReturnValue(false);

    vi.advanceTimersByTime(1_600);

    expect(win.moveTop).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
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

  it("remembers requested interaction while a blank window stays passive", () => {
    const { controller, windows, ctx } = createPresentationProbe({
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

    expect(ctx.overlayInteractiveMode).toBe(true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(win.isFocusable()).toBe(false);
    expect(win.focus).not.toHaveBeenCalled();
  });

  it("keeps a hidden sibling passive when an existing window is refreshed", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });
    controller.createOverlayWindow();
    controller.hideOverlayWindow();
    controller.setOverlayInteractiveMode(true);
    controller.createOverlayWindow({ show: false });

    expect(controller.isOverlayWindowVisible()).toBe(false);
    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(windows[0].isFocusable()).toBe(false);
  });

  it("re-shows a hidden interactive window clickable but never focusable or focused", () => {
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
    controller.createOverlayWindow();
    controller.setOverlayInteractiveMode(true);
    controller.markRendererReady(1);

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(win.setFocusable).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it("makes a window focusable only on the hotkey's request, then focuses it", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    controller.setOverlayInteractiveMode(true);
    expect(win.setFocusable).not.toHaveBeenCalled();

    controller.setOverlayInteractiveMode(true, { focus: true });
    expect(win.setFocusable).toHaveBeenCalledExactlyOnceWith(true);
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.setFocusable.mock.invocationCallOrder[0]).toBeLessThan(
      win.focus.mock.invocationCallOrder[0]!,
    );

    controller.hideOverlayWindow();
    controller.showOverlayWindowInactive();
    expect(win.isFocusable()).toBe(false);
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
    expect(fresh.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true);
    expect(fresh.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(fresh.setBounds).toHaveBeenCalledWith(stale.getBounds(), false);

    controller.markRendererReady(1);
    expect(fresh.webContents.send).toHaveBeenCalledWith("relic-reward-items", [
      { name: "Forma Blueprint" },
    ]);
  });

  it("shows an interactive linux window again without a rebuild", () => {
    const { controller, windows, ctx } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });
    ctx.overlayInteractiveMode = true;

    controller.createOverlayWindow();
    controller.hideOverlayWindow();
    controller.createOverlayWindow({ show: false });
    controller.showOverlayWindowInactive();

    expect(windows).toHaveLength(1);
    expect(windows[0].setIgnoreMouseEvents).not.toHaveBeenCalledWith(true);
    expect(controller.isOverlayWindowVisible()).toBe(true);
  });

  it("shows a pre-warmed interactive linux window without a rebuild", () => {
    const { controller, windows, ctx } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });
    ctx.overlayInteractiveMode = true;

    controller.createOverlayWindow({ show: false });
    controller.markRendererReady(1);
    controller.showOverlayWindowInactive();

    expect(windows).toHaveLength(1);
    expect(windows[0].setIgnoreMouseEvents).not.toHaveBeenCalledWith(true);
  });

  it("still makes a hidden passive linux window click-through", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "linux",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.hideOverlayWindow();
    windows[0].setIgnoreMouseEvents.mockClear();
    controller.createOverlayWindow({ show: false });

    expect(windows[0].setIgnoreMouseEvents).toHaveBeenCalledWith(true);
  });

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

  it("cannot restore clicks when a never-click-through window reports ready after a hide", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
      neverClickThrough: true,
    });

    controller.createOverlayWindow();
    controller.hideOverlayWindow();
    windows[0].setIgnoreMouseEvents.mockClear();

    controller.markRendererReady(1);

    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(windows[0].isFocusable()).toBe(false);
  });

  it("restores clicks when a visible never-click-through window reports ready", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
      neverClickThrough: true,
    });

    controller.createOverlayWindow();
    windows[0].setIgnoreMouseEvents.mockClear();

    controller.markRendererReady(1);

    expect(windows[0].setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  it("survives a long run of Windows shows and hides on one window", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];

    for (let crack = 0; crack < 12; crack += 1) {
      controller.hideOverlayWindow();
      controller.createOverlayWindow();
    }

    expect(windows).toHaveLength(1);
    expect(win.destroy).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(controller.isOverlayWindowVisible()).toBe(true);
  });

  it("blanks and restores a Windows overlay without touching its window", () => {
    const { controller, windows, contentEvents } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];

    controller.hideOverlayWindow();
    controller.showOverlayWindowInactive();

    expect(windows[0]).toBe(win);
    expect(win.destroy).not.toHaveBeenCalled();
    expect(contentEvents(win).map(([, visible]) => visible)).toEqual([true, false, true]);
  });

  it("hides a Windows overlay by blanking it and handing input back", () => {
    const { controller, windows, contentEvents } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    win.setIgnoreMouseEvents.mockClear();

    controller.hideOverlayWindow();

    expect(contentEvents(win).at(-1)).toEqual([OVERLAY_CONTENT_VISIBLE, false]);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(win.isFocusable()).toBe(false);
    expect(win.isVisible()).toBe(true);
    expect(controller.isOverlayWindowVisible()).toBe(false);
  });

  // Each blur() or setFocusable(false) on a mapped window is a SetForegroundWindow on
  // the window below it, so a passive overlay must never make either call.
  it("shows and hides a passive Windows overlay without blur or a focusable flip", () => {
    vi.useFakeTimers();
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];
    for (let crack = 0; crack < 3; crack += 1) {
      controller.hideOverlayWindow();
      controller.createOverlayWindow();
      controller.setOverlayInteractiveMode(false);
      controller.scheduleOverlayAutoHide(500);
      vi.advanceTimersByTime(600);
      controller.showOverlayWindowInactive();
      controller.markRendererReady(1);
    }
    controller.hideForUnfocus();
    controller.restoreAfterUnfocus();

    expect(win.blur).not.toHaveBeenCalled();
    expect(win.setFocusable).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it("takes clicks on Windows without rebuilding the window", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
    });

    controller.createOverlayWindow();
    controller.markRendererReady(1);
    const win = windows[0];

    controller.setOverlayInteractiveMode(true, { focus: true });

    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(win.setFocusable).toHaveBeenLastCalledWith(true);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
    expect(windows).toHaveLength(1);
  });

  it("re-asserts the raise on Windows but not on native Wayland", async () => {
    vi.useFakeTimers();
    const onWindows = createPresentationProbe({ platform: "win32", nativeWayland: false });
    const onWayland = createPresentationProbe({ platform: "linux", nativeWayland: true });

    for (const probe of [onWindows, onWayland]) {
      probe.controller.createOverlayWindow();
      probe.controller.markRendererReady(1);
      probe.windows[0].moveTop.mockClear();
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onWindows.windows[0].moveTop).toHaveBeenCalled();
    expect(onWayland.windows[0].moveTop).not.toHaveBeenCalled();
  });

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

  it("passive interactive-mode exit re-shows a window that really hides", () => {
    const { controller, windows } = createPresentationProbe({
      platform: "win32",
      nativeWayland: false,
      transparent: false,
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

describe("presentation end", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function probe() {
    const onPresentationEnd = vi.fn();
    return {
      onPresentationEnd,
      ...createPresentationProbe({ platform: "win32", nativeWayland: false, onPresentationEnd }),
    };
  }

  it("reports a dismiss and an auto-hide of a shown overlay once each", () => {
    vi.useFakeTimers();
    const { controller, onPresentationEnd } = probe();
    controller.createOverlayWindow();
    controller.markRendererReady(1);

    controller.hideOverlayWindow();
    controller.hideOverlayWindow();
    expect(onPresentationEnd).toHaveBeenCalledTimes(1);

    controller.createOverlayWindow();
    controller.scheduleOverlayAutoHide(500);
    vi.advanceTimersByTime(600);
    expect(onPresentationEnd).toHaveBeenCalledTimes(2);
  });

  it("does not report unfocus or transient hides", () => {
    const { controller, onPresentationEnd } = probe();
    controller.createOverlayWindow();
    controller.markRendererReady(1);

    controller.hideForUnfocus();
    controller.restoreAfterUnfocus();
    controller.hideOverlayWindow({ transient: true });

    expect(onPresentationEnd).not.toHaveBeenCalled();
    expect(controller.isOverlayWindowVisible()).toBe(false);
  });
});

describe("show raise reassert", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("preserves custom dimensions and scale when only the position changes", () => {
    const ctx = {
      overlaySettings: {
        overlayWindowBounds: {
          reward: { x: 10, y: 20, width: 1100, height: 200 },
        },
        overlayWindowScales: { reward: 1.25 },
      } as unknown as OverlaySettings,
    };
    const handler = createOverlayWindowBoundsChangeHandler({ ctx, save: vi.fn() });

    handler("reward", { x: 30, y: 40 });

    expect(ctx.overlaySettings.overlayWindowBounds.reward).toEqual({
      x: 30,
      y: 40,
      width: 1100,
      height: 200,
    });
    expect(ctx.overlaySettings.overlayWindowScales.reward).toBe(1.25);
  });
});

function createResizeProbe(
  windowHeight = 140,
  grantTrim: { width: number; height: number } | null = null,
) {
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const saves: OverlaySavedWindowBounds[] = [];
  let currentBounds = { x: 300, y: 400, width: 980, height: 140 };
  const windows: FakeResizableWindow[] = [];
  let zoomFactor = 1;

  class FakeResizableWindow {
    webContents = {
      id: 1,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomFactor: vi.fn((zoom: number) => {
        zoomFactor = zoom;
      }),
      getZoomFactor: () => zoomFactor,
      isLoadingMainFrame: () => false,
      isCrashed: () => false,
    };

    listeners = new Map<string, (...args: unknown[]) => void>();

    constructor() {
      windows.push(this);
    }

    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      this.listeners.set(event, listener);
    });
    loadFile = vi.fn(() => Promise.resolve());
    setAspectRatio = vi.fn();
    setBounds = vi.fn((bounds: typeof currentBounds) => {
      if (!grantTrim) {
        currentBounds = { ...bounds };
        this.listeners.get("resize")?.();
        return;
      }
      currentBounds = {
        ...bounds,
        width: bounds.width - grantTrim.width,
        height: bounds.height - grantTrim.height,
      };
      setTimeout(() => this.listeners.get("resize")?.(), 1);
    });
    getBounds = vi.fn(() => currentBounds);
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => false);
    isFocused = vi.fn(() => false);
    isFocusable = vi.fn(() => false);
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
    overlaySettings: {
      overlayWindowBounds: { reward: { x: 300, y: 400, displayId: "1" } },
    } as OverlaySettings,
    overlayInteractiveMode: true,
  };
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
    windowHeight,
    onWindowBoundsChanged: (key, bounds) => {
      saves.push(bounds);
      persist(key, bounds);
    },
    platform: "win32",
  });

  vi.useFakeTimers();
  controller.createOverlayWindow({ show: false });
  // Clears the suppression the initial positioning arms.
  vi.advanceTimersByTime(1);

  return {
    display,
    saves,
    ctx,
    controller,
    window: () => windows[windows.length - 1],
    resizeEdge: (edge: string, bounds: typeof currentBounds) => {
      const event = { preventDefault: vi.fn() };
      windows[windows.length - 1].listeners.get("will-resize")?.(event, bounds, { edge });
      if (!event.preventDefault.mock.calls.length) currentBounds = { ...bounds };
      windows[windows.length - 1].listeners.get("resize")?.();
      return event;
    },
    moveTo: (x: number, y: number) => {
      currentBounds = { ...currentBounds, x, y };
      windows[windows.length - 1].listeners.get("move")?.();
    },
    resizeTo: (width: number, height: number) => {
      currentBounds = { ...currentBounds, width, height };
      windows[windows.length - 1].listeners.get("resize")?.();
    },
  };
}

describe("overlay resize", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fits content height after a position-only drag without saving manual dimensions", () => {
    const probe = createResizeProbe(236);
    probe.moveTo(350, 450);
    probe.controller.fitOverlayContentHeight(330.2);
    vi.advanceTimersByTime(300);

    expect(probe.window().getBounds()).toEqual({ x: 350, y: 450, width: 980, height: 331 });
    expect(probe.ctx.overlaySettings.overlayWindowBounds?.reward).toEqual({
      x: 350,
      y: 450,
      displayId: "1",
    });
    probe.controller.fitOverlayContentHeight(100);
    vi.advanceTimersByTime(300);
    expect(probe.window().getBounds().height).toBe(236);
    expect(probe.saves.every((bounds) => bounds.width == null && bounds.height == null)).toBe(true);
  });

  it("saves a drag still pending when the overlay hides and leaves interactive mode", () => {
    const probe = createResizeProbe(236);
    probe.moveTo(350, 450);

    probe.controller.hideOverlayWindow();
    probe.ctx.overlayInteractiveMode = false;
    vi.advanceTimersByTime(300);

    expect(probe.saves.at(-1)).toMatchObject({ x: 350, y: 450 });
  });

  it.each(["width", "height"] as const)("preserves manually saved %s", (dimension) => {
    const probe = createResizeProbe(236);
    probe.ctx.overlaySettings.overlayWindowBounds!.reward![dimension] = 400;
    probe.controller.positionOverlayWindow();
    const before = probe.window().getBounds();
    probe.controller.fitOverlayContentHeight(600);
    expect(probe.window().getBounds()).toEqual(before);
  });

  it("does not replace a pending manual resize with content height", () => {
    const probe = createResizeProbe(236);
    probe.resizeTo(1100, 280);
    probe.controller.fitOverlayContentHeight(600);
    vi.advanceTimersByTime(300);
    expect(probe.window().getBounds()).toMatchObject({ width: 1100, height: 280 });
    expect(probe.ctx.overlaySettings.overlayWindowBounds?.reward).toMatchObject({
      width: 1100,
      height: 280,
    });
  });

  it("re-applies a content height reported while a resize save was pending", () => {
    const probe = createResizeProbe(236);
    probe.resizeTo(1100, 280);
    probe.controller.fitOverlayContentHeight(330);
    expect(probe.window().getBounds()).toMatchObject({ width: 1100, height: 280 });

    probe.ctx.overlayInteractiveMode = false;
    vi.advanceTimersByTime(300);

    expect(probe.ctx.overlaySettings.overlayWindowBounds?.reward).not.toHaveProperty("height");
    expect(probe.window().getBounds()).toMatchObject({ width: 980, height: 330 });
  });

  it("keeps a trimmed frame grant out of the saved size, however many moves it takes", () => {
    const probe = createResizeProbe(236, { width: 16, height: 8 });
    probe.controller.fitOverlayContentHeight(330);
    vi.advanceTimersByTime(300);

    expect(probe.window().getBounds()).toMatchObject({ width: 964, height: 322 });

    for (let move = 0; move < 3; move += 1) {
      probe.moveTo(350 + move, 450 + move);
      vi.advanceTimersByTime(300);
      probe.controller.positionOverlayWindow();
      vi.advanceTimersByTime(300);
    }

    expect(probe.window().getBounds()).toMatchObject({ width: 964, height: 322 });
    expect(probe.saves.every((bounds) => bounds.width == null && bounds.height == null)).toBe(true);
  });

  it("starts a replacement window at default height without persisting automatic size", () => {
    const probe = createResizeProbe(236);
    probe.controller.fitOverlayContentHeight(330);
    vi.advanceTimersByTime(300);
    probe.window().listeners.get("closed")?.();
    probe.controller.createOverlayWindow({ show: false });
    expect(probe.window().getBounds().height).toBe(236);
    expect(probe.ctx.overlaySettings.overlayWindowBounds?.reward).not.toHaveProperty("height");
  });

  it("scales automatic height and clamps it to the display work area", () => {
    const probe = createResizeProbe(236);
    probe.ctx.overlaySettings.overlayScale = 1.25;
    probe.controller.fitOverlayContentHeight(300);
    expect(probe.window().getBounds()).toMatchObject({ width: 1225, height: 375 });
    probe.controller.fitOverlayContentHeight(10000);
    const bounds = probe.window().getBounds();
    expect(bounds.height).toBeLessThanOrEqual(probe.display.workArea.height);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(probe.display.workArea.height);
    probe.controller.fitOverlayContentHeight(236);
    expect(probe.window().getBounds().height).toBe(295);
  });

  it.each([NaN, Infinity, 0, -1, 10001])("ignores invalid content height %s", (height) => {
    const probe = createResizeProbe(236);
    const before = probe.window().getBounds();
    probe.controller.fitOverlayContentHeight(height);
    expect(probe.window().getBounds()).toEqual(before);
  });

  it.each(["left", "right", "top", "bottom", "bottom-right"])(
    "lets a native %s drag change only the requested edges without zooming",
    (edge) => {
      const probe = createResizeProbe();
      const bounds = {
        x: edge.includes("left") ? 104 : 300,
        y: edge.includes("top") ? 372 : 400,
        width: edge.includes("left") || edge.includes("right") ? 1176 : 980,
        height: edge.includes("top") || edge.includes("bottom") ? 168 : 140,
      };
      probe.window().setBounds.mockClear();
      probe.window().webContents.setZoomFactor.mockClear();

      const event = probe.resizeEdge(edge, bounds);
      probe.window().listeners.get("resized")?.();

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(probe.window().setAspectRatio).not.toHaveBeenCalled();
      expect(probe.window().setBounds).not.toHaveBeenCalled();
      expect(probe.window().webContents.setZoomFactor).not.toHaveBeenCalled();
      expect(probe.window().getBounds()).toEqual(bounds);
      expect(probe.saves).toEqual([{ ...bounds, displayId: "1" }]);
      expect(probe.ctx.overlaySettings.overlayWindowScales).toBeUndefined();
    },
  );

  it("keeps an unfinished drag through a pause and content refresh", () => {
    const probe = createResizeProbe();
    probe.resizeEdge("right", { x: 300, y: 400, width: 1176, height: 140 });
    const bounds = probe.window().getBounds();
    probe.window().setBounds.mockClear();

    vi.advanceTimersByTime(500);
    probe.controller.positionOverlayWindow();

    expect(probe.saves).toHaveLength(0);
    expect(probe.window().setBounds).not.toHaveBeenCalled();
    expect(probe.window().getBounds()).toEqual(bounds);

    probe.window().listeners.get("resized")?.();
    expect(probe.saves).toEqual([{ ...bounds, displayId: "1" }]);
    expect(probe.window().setBounds).not.toHaveBeenCalled();
  });

  it("saves a debounced resize without changing its shape or text size", () => {
    const probe = createResizeProbe();
    probe.window().setBounds.mockClear();
    probe.window().webContents.setZoomFactor.mockClear();

    probe.resizeTo(1100, 200);
    vi.advanceTimersByTime(250);

    expect(probe.saves).toEqual([{ x: 300, y: 400, width: 1100, height: 200, displayId: "1" }]);
    expect(probe.window().setBounds).not.toHaveBeenCalled();
    expect(probe.window().webContents.setZoomFactor).not.toHaveBeenCalled();
  });

  it("flushes pending size and position before a content refresh", () => {
    const probe = createResizeProbe();
    probe.resizeTo(1100, 200);
    probe.moveTo(350, 450);

    probe.controller.positionOverlayWindow();
    vi.advanceTimersByTime(500);

    expect(probe.window().getBounds()).toEqual({ x: 350, y: 450, width: 1100, height: 200 });
    expect(probe.ctx.overlaySettings.overlayWindowBounds.reward).toEqual({
      x: 350,
      y: 450,
      width: 1100,
      height: 200,
      displayId: "1",
    });
  });

  it("restores custom dimensions and applies explicit scale changes to them", () => {
    const probe = createResizeProbe();
    probe.ctx.overlaySettings.overlayWindowScales = { reward: 1.25 };
    probe.controller.positionOverlayWindow();
    vi.advanceTimersByTime(1);
    probe.resizeTo(1375, 250);
    vi.advanceTimersByTime(250);

    expect(probe.ctx.overlaySettings.overlayWindowBounds.reward).toMatchObject({
      width: 1100,
      height: 200,
    });
    probe.window().listeners.get("closed")?.();
    probe.controller.createOverlayWindow({ show: false });
    probe.controller.markRendererReady(1);

    expect(probe.window().getBounds()).toMatchObject({ width: 1375, height: 250 });
    expect(probe.window().webContents.getZoomFactor()).toBe(1.25);

    probe.ctx.overlaySettings.overlayWindowScales.reward = 1.5;
    probe.controller.positionOverlayWindow();

    expect(probe.window().getBounds()).toMatchObject({ width: 1650, height: 300 });
    expect(probe.window().webContents.getZoomFactor()).toBe(1.5);
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

  it("tracks visibility logically and drops the surface on hide", () => {
    const probe = probeWithLayer(true);
    probe.controller.createOverlayWindow();

    expect(probe.controller.isOverlayWindowVisible()).toBe(true);

    probe.controller.hideOverlayWindow();

    expect(probe.presentation.hide).toHaveBeenCalled();
    expect(probe.controller.isOverlayWindowVisible()).toBe(false);
    expect(probe.windows[0].hide).not.toHaveBeenCalled();
  });

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

    expect(saves).toEqual([{ x: 510, y: 580, displayId: "1" }]);
    expect(presentation.applyGeometry).toHaveBeenCalledTimes(1);
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
    placeOnGameOutput: (title: string, output: string | null) => Promise<boolean>,
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

    expect(place).toHaveBeenCalledWith("WFHelper Relic Rewards", null);
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
