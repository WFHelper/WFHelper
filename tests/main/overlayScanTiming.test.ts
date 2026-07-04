import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOverlayScanController } from "../../ipc/overlay/scan";

vi.mock("../../services/itemDatabase", () => ({
  lookupItem: () => null,
  lookupItemByNameOrSlug: () => null,
}));

const noop = () => {};

function createHarness() {
  const scanTimes: number[] = [];
  const autoHideDelays: number[] = [];

  const controller = createOverlayScanController({
    log: { info: noop, warn: noop, error: noop },
    rewardScanner: {
      scanRewardsDetailed: async () => {
        scanTimes.push(Date.now());
        return { items: [{ name: "Neo N1 Relic" }], meta: null };
      },
    },
    ctx: { overlaySettings: {}, overlayWindow: null, currentInventoryData: null },
    windows: {
      setAnchorMeta: noop,
      getAnchorMeta: () => null,
      positionOverlayWindow: noop,
      sendOverlayEvent: noop,
      scheduleOverlayAutoHide: (delayMs: number) => autoHideDelays.push(delayMs),
      clearOverlayAutoHideTimer: noop,
      createOverlayWindow: noop,
    },
  });

  return { controller, scanTimes, autoHideDelays };
}

describe("overlay scan timing (eelog trigger)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits the full fixed delay when no render signal arrives", async () => {
    const { controller, scanTimes } = createHarness();
    const start = Date.now();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(1_200);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(scanTimes[0] - start).toBe(1_200);
  });

  it("scans after the settle delay when the signal preceded the trigger", async () => {
    const { controller, scanTimes } = createHarness();
    controller.notifyRewardUiReady();
    const start = Date.now();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(scanTimes[0] - start).toBe(500);
  });

  it("cuts the wait short when the signal arrives mid-delay", async () => {
    const { controller, scanTimes } = createHarness();
    const start = Date.now();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(300);
    controller.notifyRewardUiReady();
    await vi.advanceTimersByTimeAsync(500);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(scanTimes[0] - start).toBe(800);
  });

  it("anchors the auto-hide to the trigger time, not the scan duration", async () => {
    const { controller, autoHideDelays } = createHarness();
    controller.notifyRewardUiReady();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;

    // 14.5s vote window minus the 500ms spent before the scan resolved.
    expect(autoHideDelays).toEqual([14_000]);
  });

  it("manual scans keep the plain success auto-hide", async () => {
    const { controller, autoHideDelays } = createHarness();

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(autoHideDelays).toEqual([8_500]);
  });
});
