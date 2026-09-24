import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_INTERACTION_MODE } from "../../config/shared/ipcChannels";

interface FakeController {
  options: { onPresentationEnd?: () => void };
  anchor: { sourceDisplayId: string };
  positionOverlayWindow: ReturnType<typeof vi.fn>;
  showOverlayWindowInactive: ReturnType<typeof vi.fn>;
  createOverlayWindow: ReturnType<typeof vi.fn>;
  setOverlayInteractiveMode: ReturnType<typeof vi.fn>;
  getAnchorMeta: () => { sourceDisplayId: string };
  isKeepMappedActive: () => boolean;
  isOverlayWindowVisible: () => boolean;
  markRendererReady: ReturnType<typeof vi.fn>;
  hideOverlayWindow: ReturnType<typeof vi.fn>;
  getOverlayBoundsForActiveDisplay: ReturnType<typeof vi.fn>;
  isHiddenByUnfocus: () => boolean;
  hideForUnfocus: ReturnType<typeof vi.fn>;
  restoreAfterUnfocus: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  controllers: [] as unknown[],
  keepMapped: true,
  visible: true,
  destroyLeft: vi.fn(),
  destroyRight: vi.fn(),
  returnFocus: vi.fn(() => true),
}));

vi.mock("electron", () => ({
  app: { getAppPath: () => "D:/app" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  screen: {},
  shell: {},
}));
vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../services/windowSecurity", () => ({ hardenBrowserWindowNavigation: vi.fn() }));
vi.mock("../../ipc/ipcSecurity", () => ({
  assertRivenOverlayRendererSender: vi.fn(),
  onAuthorized: vi.fn(),
}));
vi.mock("../../ipc/overlay/windows", () => ({
  createOverlayWindowBoundsChangeHandler: () => vi.fn(),
  createOverlayWindowsController: (options: { onPresentationEnd?: () => void }) => {
    const label = state.controllers.length === 0 ? "left" : "right";
    const controller: FakeController = {
      options,
      anchor: { sourceDisplayId: label },
      positionOverlayWindow: vi.fn(),
      showOverlayWindowInactive: vi.fn(),
      createOverlayWindow: vi.fn(),
      setOverlayInteractiveMode: vi.fn(),
      getAnchorMeta: () => controller.anchor,
      isKeepMappedActive: () => state.keepMapped,
      isOverlayWindowVisible: () => state.visible,
      markRendererReady: vi.fn(),
      hideOverlayWindow: vi.fn(),
      getOverlayBoundsForActiveDisplay: vi.fn(),
      isHiddenByUnfocus: () => false,
      hideForUnfocus: vi.fn(() => false),
      restoreAfterUnfocus: vi.fn(() => false),
    };
    state.controllers.push(controller);
    return controller;
  },
}));
vi.mock("../../ipc/overlay/zOrder", () => ({
  applyOverlayZOrder: vi.fn(),
  canRaiseOverlayWindows: () => true,
  registerZOrderSubscriber: vi.fn(),
  returnFocusToWarframe: state.returnFocus,
  syncOverlayWindowZOrder: vi.fn(),
  syncUnfocusHide: vi.fn(),
}));
vi.mock("../../ipc/overlay/rivenSession", () => ({
  setEventRecorder: vi.fn(),
  createScanGeneration: () => ({
    begin: () => 1,
    invalidate: vi.fn(),
    isCurrent: () => true,
    current: () => 1,
  }),
  startSession: vi.fn(),
  endSession: vi.fn(),
  onInitialStats: vi.fn(),
  onRollConfirmed: vi.fn(),
  onRollFailed: vi.fn(),
  onRollResult: vi.fn(),
  onChoiceMade: vi.fn(),
}));
vi.mock("../../ipc/overlay/rivenScan", () => ({
  abortRivenScans: vi.fn(),
  resetRivenScanAbort: vi.fn(),
  scanInitialCard: vi.fn(async () => ({ stats: [], rawText: "", titleText: "" })),
  scanNewRoll: vi.fn(),
  scanChoiceRescan: vi.fn(),
}));
vi.mock("../../ipc/overlay/rivenWeaponLabel", () => ({
  readFitsInWeapon: vi.fn(),
  readFitsInWeaponSmallUi: vi.fn(),
  shouldApplyLabelWeapon: vi.fn(() => false),
}));
vi.mock("../../services/screenCapture", () => ({ captureScreenFast: vi.fn() }));
vi.mock("../../services/rivenData", () => ({
  findWeaponInText: vi.fn(),
  getRivenFamilySlug: vi.fn(),
  getWeaponNameByUniqueName: vi.fn(),
  isMeleeWeapon: vi.fn(() => false),
}));
vi.mock("../../services/rivenGrading", () => ({
  gradeRiven: vi.fn(),
  correctScannedStats: vi.fn((_weapon: string, stats: unknown[]) => ({ stats })),
}));
vi.mock("../../services/rivenBestAttributes", () => ({
  ensureRivenGoodRollsLoaded: vi.fn(),
  getBestAttributes: vi.fn(),
}));
vi.mock("../../services/wfmRivenSearch", () => ({ searchRivenAuctions: vi.fn() }));
vi.mock("../../services/warframeStatus", () => ({
  isOwnProcessForeground: () => false,
  isWarframeWindowFocusedLinux: () => true,
  isWindowTopmost: () => true,
}));
vi.mock("../../services/eeLogPath", () => ({ resolveWarframeUiScale: () => 1 }));
vi.mock("../../services/eeLogMonitor", () => ({
  forceEndRivenSession: vi.fn(),
  resumeRivenSession: vi.fn(),
}));

const fakeWindow = (destroy: ReturnType<typeof vi.fn>) => ({
  destroy,
  isDestroyed: () => false,
  isAlwaysOnTop: () => true,
  getNativeWindowHandle: () => Buffer.alloc(0),
  webContents: { id: 1, send: vi.fn(), on: vi.fn(), once: vi.fn() },
});

vi.mock("../../ipc/context", () => ({
  default: {
    overlaySettings: { rivenOverlayEnabled: true },
    overlayThemeVars: {},
    overlayInteractiveMode: false,
    rivenOverlayLeftWindow: null as unknown,
    rivenOverlayRightWindow: null as unknown,
  },
}));

import ctx from "../../ipc/context";
import {
  isRivenInteractiveMode,
  onRivenSessionClose,
  onRivenSessionOpen,
  setRivenInteractiveMode,
} from "../../ipc/rivenOverlayIpc";

function controllers(): FakeController[] {
  return state.controllers as FakeController[];
}

describe("riven panels reused by a second session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.keepMapped = true;
    state.visible = true;
    state.destroyLeft = vi.fn();
    state.destroyRight = vi.fn();
    (ctx as unknown as Record<string, unknown>).rivenOverlayLeftWindow = fakeWindow(
      state.destroyLeft,
    );
    (ctx as unknown as Record<string, unknown>).rivenOverlayRightWindow = fakeWindow(
      state.destroyRight,
    );
    for (const controller of controllers()) {
      controller.positionOverlayWindow.mockClear();
      controller.showOverlayWindowInactive.mockClear();
      controller.createOverlayWindow.mockClear();
    }
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("repositions the kept panels instead of rebuilding them", () => {
    onRivenSessionOpen();

    expect(controllers()).toHaveLength(2);
    for (const controller of controllers()) {
      expect(controller.positionOverlayWindow).toHaveBeenCalledWith(controller.anchor);
      expect(controller.showOverlayWindowInactive).toHaveBeenCalled();
      expect(controller.createOverlayWindow).not.toHaveBeenCalled();
    }
    expect(state.destroyLeft).not.toHaveBeenCalled();
    expect(state.destroyRight).not.toHaveBeenCalled();
  });

  it("repositions before the panels are shown", () => {
    onRivenSessionOpen();

    for (const controller of controllers()) {
      expect(controller.positionOverlayWindow.mock.invocationCallOrder[0]).toBeLessThan(
        controller.showOverlayWindowInactive.mock.invocationCallOrder[0]!,
      );
    }
  });

  it("still rebuilds hidden panels when keep-mapped mode is off", () => {
    state.keepMapped = false;
    state.visible = false;

    onRivenSessionOpen();

    expect(state.destroyLeft).toHaveBeenCalled();
    expect(state.destroyRight).toHaveBeenCalled();
    for (const controller of controllers()) {
      expect(controller.createOverlayWindow).toHaveBeenCalled();
    }
  });
});

describe("riven interactive mode ends with the panels", () => {
  type SendMock = ReturnType<typeof vi.fn>;
  const panels = () =>
    [ctx.rivenOverlayLeftWindow, ctx.rivenOverlayRightWindow] as unknown as Array<{
      webContents: { send: SendMock };
    }>;
  const interactionEvents = (send: SendMock) =>
    send.mock.calls.filter(([channel]) => channel === OVERLAY_INTERACTION_MODE);

  beforeEach(() => {
    vi.useFakeTimers();
    state.visible = true;
    state.keepMapped = true;
    (ctx as unknown as Record<string, unknown>).rivenOverlayLeftWindow = fakeWindow(vi.fn());
    (ctx as unknown as Record<string, unknown>).rivenOverlayRightWindow = fakeWindow(vi.fn());
    setRivenInteractiveMode(true);
    for (const controller of controllers()) controller.setOverlayInteractiveMode.mockClear();
    for (const panel of panels()) panel.webContents.send.mockClear();
    state.returnFocus.mockClear();
  });

  afterEach(() => {
    ctx.overlayInteractiveMode = false;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("leaves focus with a reward overlay the player is still using", () => {
    ctx.overlayInteractiveMode = true;

    onRivenSessionClose();

    expect(isRivenInteractiveMode()).toBe(false);
    expect(state.returnFocus).not.toHaveBeenCalled();
  });

  it("a closed session leaves both panels click-through and tells their renderers", () => {
    onRivenSessionClose();

    expect(isRivenInteractiveMode()).toBe(false);
    for (const controller of controllers()) {
      expect(controller.hideOverlayWindow).toHaveBeenCalled();
      expect(controller.setOverlayInteractiveMode).toHaveBeenLastCalledWith(false, {
        focus: true,
      });
    }
    for (const panel of panels()) {
      expect(interactionEvents(panel.webContents.send)).toEqual([
        [OVERLAY_INTERACTION_MODE, { interactive: false }],
      ]);
    }
    expect(state.returnFocus).toHaveBeenCalledOnce();
  });

  it("ends when the last panel is hidden for good, not while one is still up", () => {
    controllers()[0].options.onPresentationEnd?.();
    expect(isRivenInteractiveMode()).toBe(true);

    state.visible = false;
    controllers()[1].options.onPresentationEnd?.();

    expect(isRivenInteractiveMode()).toBe(false);
    expect(state.returnFocus).toHaveBeenCalledOnce();
  });

  it("a reopened session starts click-through", () => {
    state.visible = false;

    onRivenSessionOpen();

    expect(isRivenInteractiveMode()).toBe(false);
    for (const controller of controllers()) {
      expect(controller.setOverlayInteractiveMode).toHaveBeenLastCalledWith(false);
    }
  });
});
