import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOverlayScanController } from "../../ipc/overlay/scan";

vi.mock("../../services/itemDatabase", () => ({
  localizedNameFields: () => ({}),
  lookupItem: () => null,
  lookupItemByNameOrSlug: () => null,
  isReusableBlueprint: () => false,
}));

const noop = () => {};

type WarframeStatus = {
  isOpen: boolean;
  isFocused: boolean;
  focusedProcessName?: string | null;
  focusedDisplayId?: string | null;
};

/** The status probe costs real time before the capture, which is the point here. */
function createHarness(statusDelayMs: number) {
  const scanTimes: number[] = [];
  const infoLines: string[] = [];

  const controller = createOverlayScanController({
    log: {
      info: (...args: unknown[]) => infoLines.push(args.join(" ")),
      warn: noop,
      error: noop,
    },
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
      scheduleOverlayAutoHide: noop,
      clearOverlayAutoHideTimer: noop,
      createOverlayWindow: noop,
    },
    warframeStatus: {
      getStatus: () =>
        new Promise<WarframeStatus>((resolve) => {
          setTimeout(
            () => resolve({ isOpen: true, isFocused: true, focusedDisplayId: "display-1" }),
            statusDelayMs,
          );
        }),
    },
  });

  return { controller, scanTimes, infoLines };
}

describe("overlay scan trigger timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures 650ms after the trigger even when the status probe is slow", async () => {
    const { controller, scanTimes } = createHarness(200);
    const start = Date.now();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(650);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(scanTimes[0] - start).toBe(650);
  });

  it("charges a late-delivered trigger line and the status probe to the same delay", async () => {
    const { controller, scanTimes } = createHarness(200);
    const start = Date.now();

    const done = controller.dispatchRewardScan("eelog", 400);
    await vi.advanceTimersByTimeAsync(250);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(scanTimes[0] - start).toBe(250);
  });

  it("logs one render signal per reward screen", async () => {
    const { controller, infoLines } = createHarness(0);

    const first = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(100);
    controller.notifyRewardUiReady();
    controller.notifyRewardUiReady();
    controller.notifyRewardUiReady();
    await vi.advanceTimersByTimeAsync(550);
    await first;

    expect(infoLines.filter((line) => line.includes("render signal"))).toHaveLength(1);

    const second = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(100);
    controller.notifyRewardUiReady();
    await vi.advanceTimersByTimeAsync(550);
    await second;

    expect(infoLines.filter((line) => line.includes("render signal"))).toHaveLength(2);
  });
});
