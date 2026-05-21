import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RELIC_RECOMMENDATIONS } from "../../config/shared/ipcChannels";
import { createRelicSelectionController } from "../../ipc/overlay/relicSelection";

const tempDirs: string[] = [];

function makeTempSnapshot(snapshot: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-relic-selection-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "snapshot-cache.json");
  fs.writeFileSync(filePath, JSON.stringify(snapshot), "utf-8");
  return filePath;
}

describe("relic selection planner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses snapshot prices even when their entry timestamp is older than the live cache ttl", async () => {
    const staleTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: staleTimestamp,
      prices: {
        akarius_prime_blueprint: {
          status: "ok",
          median: 15,
          timestamp: staleTimestamp,
        },
      },
      meta: {
        akarius_prime_blueprint: {
          ducats: 100,
        },
      },
      orderSummaries: {},
    });

    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const controller = createRelicSelectionController({
      log: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      ctx: {
        overlaySettings: {
          autoTriggerEnabled: true,
        } as never,
        currentInventoryData: {
          LevelKeys: [{ ItemType: "/Lotus/Types/Game/Projections/NeoTestIntact", ItemCount: 1 }],
        },
      },
      windows: {
        createOverlayWindow: vi.fn(),
        clearOverlayAutoHideTimer: vi.fn(),
        scheduleOverlayAutoHide: vi.fn(),
        sendOverlayEvent: (channel, payload) => sentEvents.push({ channel, payload }),
        positionOverlayWindow: vi.fn(),
        getAnchorMeta: () => null,
        setAnchorMeta: vi.fn(),
      },
      relicService: {
        getRelicDatabase: () => ({
          groups: {
            "Neo Test": {
              key: "Neo Test",
              name: "Neo Test",
              tier: "Neo",
              qualities: {
                intact: {
                  rewards: [
                    {
                      chance: 100,
                      urlName: "akarius_prime_blueprint",
                      ducats: null,
                      rarity: "Rare",
                    },
                  ],
                },
              },
            },
          },
          byUniqueName: {
            "/Lotus/Types/Game/Projections/NeoTestIntact": {
              groupKey: "Neo Test",
              quality: "intact",
            },
          },
        }),
      },
      rewardScanner: {
        detectRelicSelectionEra: async () => ({
          era: "Neo",
          confidence: 1,
        }),
      },
      wfmStatsPrice: {
        getCachedPriceBySlug: vi.fn(),
      },
      fs,
      cacheFilePath,
    });

    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const recommendation = sentEvents
      .filter((event) => event.channel === RELIC_RECOMMENDATIONS)
      .at(-1)?.payload as { rows?: Array<{ platEv: number | null; ducatEv: number | null }> };

    expect(recommendation.rows?.[0]?.platEv).toBe(15);
    expect(recommendation.rows?.[0]?.ducatEv).toBe(100);
  });
});
