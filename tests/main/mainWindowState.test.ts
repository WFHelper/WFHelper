import { describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ written: [] as unknown[] }));
vi.mock("electron", () => ({ screen: {} }));
vi.mock("../../services/logger", () => ({ withScope: () => ({ warn: vi.fn() }) }));
vi.mock("../../services/jsonCache", () => ({
  createJsonCache: () => ({
    read: () => null,
    write: (state: unknown) => cache.written.push(state),
  }),
}));

import { fitBoundsToDisplays, saveMainWindowState } from "../../services/mainWindowState";

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECONDARY = { x: 1920, y: 0, width: 1280, height: 720 };
const MIN = { width: 900, height: 600 };

describe("fitBoundsToDisplays", () => {
  it("keeps bounds that already fit", () => {
    const bounds = { x: 100, y: 80, width: 1280, height: 820 };
    expect(fitBoundsToDisplays(bounds, [PRIMARY, SECONDARY], MIN)).toEqual(bounds);
  });

  it("restores onto the secondary display it was left on", () => {
    const bounds = { x: 2000, y: 40, width: 1000, height: 640 };
    expect(fitBoundsToDisplays(bounds, [PRIMARY, SECONDARY], MIN)).toEqual(bounds);
  });

  it("pulls a mostly-offscreen window back onto its display", () => {
    const fitted = fitBoundsToDisplays({ x: 1850, y: 0, width: 1280, height: 820 }, [PRIMARY], MIN);
    expect(fitted).toEqual({ x: 640, y: 0, width: 1280, height: 820 });
  });

  it("shrinks bounds larger than the display and keeps the minimum size", () => {
    const fitted = fitBoundsToDisplays(
      { x: 1920, y: 0, width: 2560, height: 1440 },
      [SECONDARY],
      MIN,
    );
    expect(fitted).toEqual({ x: 1920, y: 0, width: 1280, height: 720 });

    const tiny = fitBoundsToDisplays({ x: 1920, y: 0, width: 200, height: 100 }, [SECONDARY], MIN);
    expect(tiny).toEqual({ x: 1920, y: 0, width: 900, height: 600 });
  });

  it("anchors an oversized minimum at the work-area origin", () => {
    const compact = { x: 0, y: 0, width: 800, height: 500 };
    const fitted = fitBoundsToDisplays({ x: 100, y: 80, width: 1280, height: 820 }, [compact], MIN);
    expect(fitted).toEqual({ x: 0, y: 0, width: 900, height: 600 });
  });

  it("returns null when the saved display is gone", () => {
    expect(fitBoundsToDisplays({ x: 4000, y: 0, width: 1280, height: 820 }, [PRIMARY], MIN)).toBe(
      null,
    );
    expect(fitBoundsToDisplays({ x: 0, y: 0, width: 1280, height: 820 }, [], MIN)).toBe(null);
  });

  it("prefers the display holding most of the window", () => {
    const fitted = fitBoundsToDisplays(
      { x: 1700, y: 0, width: 1000, height: 640 },
      [PRIMARY, SECONDARY],
      MIN,
    );
    expect(fitted).toEqual({ x: 1920, y: 0, width: 1000, height: 640 });
  });
});

describe("saveMainWindowState", () => {
  it("keeps a window that is still to be maximized saved as maximized", () => {
    const win = {
      isDestroyed: () => false,
      isMaximized: () => false,
      getNormalBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
    };
    cache.written.length = 0;
    saveMainWindowState(win as never);
    saveMainWindowState(win as never, true);
    expect(cache.written).toEqual([
      { x: 10, y: 20, width: 1200, height: 800, maximized: false },
      { x: 10, y: 20, width: 1200, height: 800, maximized: true },
    ]);
  });
});
