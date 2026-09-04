import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOverlayScanController } from "../../ipc/overlay/scan";

vi.mock("../../services/itemDatabase", () => ({
  localizedNameFields: () => ({}),
  lookupItem: () => null,
  lookupItemByNameOrSlug: () => null,
  isReusableBlueprint: () => false,
}));

const noop = () => {};

type ScanResult = { items: unknown[]; meta: Record<string, unknown> | null };

const foundReward: ScanResult = { items: [{ name: "Neo N1 Relic" }], meta: null };

type HarnessStatus = {
  isOpen: boolean;
  isFocused: boolean;
  focusedProcessName?: string | null;
  focusedDisplayId?: string | null;
};

type StatusOptions = { force?: boolean };

function createHarness(
  result: ScanResult = foundReward,
  options: { results?: ScanResult[]; status?: () => HarnessStatus } = {},
) {
  const scanTimes: number[] = [];
  const autoHideDelays: number[] = [];
  const sentItems: unknown[][] = [];
  const statusCalls: Array<StatusOptions | undefined> = [];
  const infoLines: string[] = [];
  const warnLines: string[] = [];
  const statusFn = options.status;

  const controller = createOverlayScanController({
    log: {
      info: (...args: unknown[]) => infoLines.push(args.join(" ")),
      warn: (...args: unknown[]) => warnLines.push(args.join(" ")),
      error: noop,
    },
    rewardScanner: {
      scanRewardsDetailed: async () => {
        scanTimes.push(Date.now());
        const queue = options.results;
        if (!queue) return result;
        return queue[Math.min(scanTimes.length - 1, queue.length - 1)];
      },
    },
    ctx: { overlaySettings: {}, overlayWindow: null, currentInventoryData: null },
    windows: {
      setAnchorMeta: noop,
      getAnchorMeta: () => null,
      positionOverlayWindow: noop,
      sendOverlayEvent: (_channel: string, payload?: unknown) => {
        if (Array.isArray(payload)) sentItems.push(payload);
      },
      scheduleOverlayAutoHide: (delayMs: number) => autoHideDelays.push(delayMs),
      clearOverlayAutoHideTimer: noop,
      createOverlayWindow: noop,
    },
    ...(statusFn
      ? {
          warframeStatus: {
            getStatus: async (statusOptions?: StatusOptions) => {
              statusCalls.push(statusOptions);
              return statusFn();
            },
          },
        }
      : {}),
  });

  return { controller, scanTimes, autoHideDelays, sentItems, statusCalls, infoLines, warnLines };
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
    await vi.advanceTimersByTimeAsync(600);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(scanTimes[0] - start).toBe(600);
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

  it("refreshes status before anchoring an eelog scan", async () => {
    const { controller, statusCalls } = createHarness(foundReward, {
      status: () => ({ isOpen: true, isFocused: true, focusedDisplayId: "display-1" }),
    });

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(600);
    await done;

    expect(statusCalls[0]).toEqual({ force: true });
  });

  it("gives up after three scans that find no reward layout", async () => {
    const { controller, scanTimes } = createHarness({ items: [], meta: { layoutCount: 0 } });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(3);
  });

  it("keeps retrying while a reward layout is on screen", async () => {
    const { controller, scanTimes } = createHarness({ items: [], meta: { layoutCount: 4 } });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes.length).toBeGreaterThan(3);
  });

  it("manual scans keep the plain success auto-hide", async () => {
    const { controller, autoHideDelays } = createHarness();

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(autoHideDelays).toEqual([8_500]);
  });

  it("rescans once when OCR fills fewer slots than the layout has", async () => {
    const twoOfFour: ScanResult = {
      items: [{ name: "A" }, { name: "B" }],
      meta: { layoutCount: 4 },
    };
    const fourOfFour: ScanResult = {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
      meta: { layoutCount: 4 },
    };
    const { controller, scanTimes, sentItems } = createHarness(twoOfFour, {
      results: [twoOfFour, fourOfFour],
    });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(2);
    expect(sentItems.at(-1)).toHaveLength(4);
  });

  it("keeps the fuller partial when the bonus attempt does not improve", async () => {
    const twoOfFour: ScanResult = {
      items: [{ name: "A" }, { name: "B" }],
      meta: { layoutCount: 4 },
    };
    const { controller, scanTimes, sentItems } = createHarness(twoOfFour, {
      results: [twoOfFour, twoOfFour],
    });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(2);
    expect(sentItems.at(-1)).toHaveLength(2);
  });

  it("does not rescan a full three-card read", async () => {
    const threeOfThree: ScanResult = {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
      meta: { layoutCount: 4, slotCount: 3 },
    };
    const { controller, scanTimes, sentItems } = createHarness(threeOfThree);

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(sentItems.at(-1)).toHaveLength(3);
  });

  it("rescans a full two-card read because the 4-card grid shares its centres", async () => {
    const twoOfTwo: ScanResult = {
      items: [{ name: "A" }, { name: "B" }],
      meta: { layoutCount: 4, slotCount: 2 },
    };
    const { controller, scanTimes } = createHarness(twoOfTwo, { results: [twoOfTwo, twoOfTwo] });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(2);
  });

  it("rescans a lone card because the 3-card grid shares its centre", async () => {
    const oneOfOne: ScanResult = { items: [{ name: "A" }], meta: { layoutCount: 4, slotCount: 1 } };
    const { controller, scanTimes } = createHarness(oneOfOne, { results: [oneOfOne, oneOfOne] });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(2);
  });

  it("trusts the card bars: a read that fills the counted cards is complete", async () => {
    const twoCounted: ScanResult = {
      items: [{ name: "A" }, { name: "B" }],
      meta: { layoutCount: 1, slotCount: 2, cardCount: 2 },
    };
    const { controller, scanTimes, sentItems } = createHarness(twoCounted);

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(scanTimes).toHaveLength(1);
    expect(sentItems.at(-1)).toHaveLength(2);
  });

  it("rescans when fewer cards were read than the bars counted", async () => {
    const threeOfFourCounted: ScanResult = {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
      meta: { layoutCount: 1, slotCount: 4, cardCount: 4 },
    };
    const { controller, scanTimes } = createHarness(threeOfFourCounted, {
      results: [threeOfFourCounted, threeOfFourCounted],
    });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(2);
  });

  it("sends nothing when the bonus attempt still misses a counted card", async () => {
    const threeOfFourCounted: ScanResult = {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
      meta: { layoutCount: 1, slotCount: 4, cardCount: 4 },
    };
    const { controller, scanTimes, sentItems, warnLines, infoLines } = createHarness(
      threeOfFourCounted,
      { results: [threeOfFourCounted, threeOfFourCounted] },
    );

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(2);
    expect(sentItems.at(-1)).toEqual([]);
    expect(warnLines.some((line) => line.includes("gave up: 3/4 counted cards"))).toBe(true);
    expect(warnLines.some((line) => line.includes("after 2 attempt(s)"))).toBe(true);
    expect(infoLines.some((line) => line.includes("reward scan resolved"))).toBe(false);
  });

  it("ships the set when the bonus attempt fills the last counted card", async () => {
    const threeOfFourCounted: ScanResult = {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }],
      meta: { layoutCount: 1, slotCount: 4, cardCount: 4 },
    };
    const fourOfFourCounted: ScanResult = {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
      meta: { layoutCount: 1, slotCount: 4, cardCount: 4 },
    };
    const { controller, scanTimes, sentItems, warnLines } = createHarness(threeOfFourCounted, {
      results: [threeOfFourCounted, fourOfFourCounted],
    });

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(scanTimes).toHaveLength(2);
    expect(sentItems.at(-1)).toHaveLength(4);
    expect(warnLines.some((line) => line.includes("gave up"))).toBe(false);
  });

  it("does not rescan a clean sweep", async () => {
    const fourOfFour: ScanResult = {
      items: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
      meta: { layoutCount: 4 },
    };
    const { controller, scanTimes } = createHarness(fourOfFour);

    const done = controller.dispatchRewardScan("manual");
    await vi.advanceTimersByTimeAsync(0);
    await done;

    expect(scanTimes).toHaveLength(1);
  });

  it("skips the eelog scan when Warframe is unfocused with no focused display", async () => {
    const { controller, scanTimes, autoHideDelays } = createHarness(foundReward, {
      status: () => ({ isOpen: true, isFocused: false, focusedProcessName: "brave" }),
    });

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    expect(scanTimes).toHaveLength(0);
    expect(autoHideDelays).toEqual([3_500]);
  });

  it("holds the auto-hide while Warframe is unfocused, hides after refocus grace", async () => {
    let focused = false;
    const { controller, autoHideDelays } = createHarness(foundReward, {
      status: () => ({
        isOpen: true,
        isFocused: focused,
        focusedProcessName: "brave",
        focusedDisplayId: "display-2",
      }),
    });
    controller.notifyRewardUiReady();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;

    expect(autoHideDelays).toEqual([]);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(autoHideDelays).toEqual([]);

    focused = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(autoHideDelays).toEqual([2_500]);
  });

  it("hides shortly after the reward screen shuts down (solo close)", async () => {
    const { controller, autoHideDelays } = createHarness();
    controller.notifyRewardUiReady();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(autoHideDelays).toEqual([14_000]);

    // Solo: the in-game screen closes ~5.5s after the trigger.
    await vi.advanceTimersByTimeAsync(5_000);
    controller.notifyRewardScreenClosed(0);
    expect(autoHideDelays.at(-1)).toBe(1_500);
  });

  it("keeps the reading floor when the screen closes right away", async () => {
    const { controller, autoHideDelays } = createHarness();
    controller.notifyRewardUiReady();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;

    await vi.advanceTimersByTimeAsync(1_000);
    controller.notifyRewardScreenClosed(0);
    // 5s reading floor from the trigger, 1.5s of it already elapsed.
    expect(autoHideDelays.at(-1)).toBe(3_500);
  });

  it("uses the minimum visible time when the screen closed mid-scan", async () => {
    const { controller, autoHideDelays } = createHarness();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(300);
    controller.notifyRewardScreenClosed(0);
    await vi.advanceTimersByTimeAsync(500);
    await done;

    expect(autoHideDelays).toEqual([5_000]);
  });

  it("acts on the first close only - picker shutdowns and echoes refire it", async () => {
    const { controller, autoHideDelays } = createHarness();
    controller.notifyRewardUiReady();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;

    await vi.advanceTimersByTimeAsync(5_000);
    controller.notifyRewardScreenClosed(0);
    expect(autoHideDelays).toEqual([14_000, 1_500]);

    await vi.advanceTimersByTimeAsync(4_500);
    controller.notifyRewardScreenClosed(0);
    controller.notifyRewardScreenClosed(2_000);
    expect(autoHideDelays).toEqual([14_000, 1_500]);
  });

  it("ignores stale close lines from the lazy file flush", async () => {
    const { controller, autoHideDelays } = createHarness();
    controller.notifyRewardUiReady();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;

    controller.notifyRewardScreenClosed(12_000);
    expect(autoHideDelays).toEqual([14_000]);
  });

  it("ignores close lines with no eelog trigger active", async () => {
    const { controller, autoHideDelays } = createHarness();

    controller.notifyRewardScreenClosed(0);
    expect(autoHideDelays).toEqual([]);
  });

  it("hides at the vote-window expiry when Warframe is focused", async () => {
    const { controller, autoHideDelays } = createHarness(foundReward, {
      status: () => ({
        isOpen: true,
        isFocused: true,
        focusedProcessName: "warframe.x64",
        focusedDisplayId: "display-1",
      }),
    });
    controller.notifyRewardUiReady();

    const done = controller.dispatchRewardScan("eelog");
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(autoHideDelays).toEqual([]);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(autoHideDelays).toEqual([250]);
  });
});
