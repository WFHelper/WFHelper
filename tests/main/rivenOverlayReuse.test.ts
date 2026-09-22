import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeController {
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
}

const state = vi.hoisted(() => ({
  controllers: [] as unknown[],
  keepMapped: true,
  visible: true,
  destroyLeft: vi.fn(),
  destroyRight: vi.fn(),
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
  createOverlayWindowsController: () => {
    const label = state.controllers.length === 0 ? "left" : "right";
    const controller: FakeController = {
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
    };
    state.controllers.push(controller);
    return controller;
  },
}));
vi.mock("../../ipc/overlay/zOrder", () => ({
  applyOverlayZOrder: vi.fn(),
  canRaiseOverlayWindows: () => true,
  isOwnWindowForeground: () => false,
  unfocusHideFocused: (focused: boolean) => focused,
  registerZOrderSubscriber: vi.fn(),
  syncOverlayWindowZOrder: vi.fn(),
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
    rivenOverlayLeftWindow: null as unknown,
    rivenOverlayRightWindow: null as unknown,
  },
}));

import ctx from "../../ipc/context";
import { onRivenSessionOpen } from "../../ipc/rivenOverlayIpc";

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
