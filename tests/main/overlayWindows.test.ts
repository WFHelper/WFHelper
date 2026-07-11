import { describe, expect, it, vi } from "vitest";

import {
  createOverlayWindowBoundsChangeHandler,
  createOverlayWindowsController,
} from "../../ipc/overlay/windows";
import type { OverlaySettings } from "../../config/runtime/overlaySettings";

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
    log: { warn: () => {} },
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
});
