import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RELIC_RECOMMENDATIONS } from "../../config/shared/ipcChannels";
import { getOverlayDescriptor } from "../../config/shared/overlayLayout";
import type { OverlaySettings } from "../../config/runtime/overlaySettings";
import { createRelicSelectionController } from "../../ipc/overlay/relicSelection";
import { detectRelicEraFromBandText } from "../../services/rewardScannerMatch";
import * as itemDatabase from "../../services/itemDatabase";

const tempDirs: string[] = [];

// Verbatim OCR previews. The first is the star chart fissure list; the second is
// WFHelper's own planner overlay read back off the screen, with "profits" and
// "VAULTED" mangled by the scan.
const STAR_CHART_FISSURE_LIST =
  "Requiem Fissure Garus (Kuva Fortres: CIII 14m ASSAULT (160-17 Requiem Fissure Koro " +
  "(Kuva Fortress) C31m 27s VOID FLOOD (158. Omnia Fissure Everview Arc";
const OWN_OVERLAY_BAND =
  "29x Requiem III Intact 6.6 E. proflts: VAULTEO 29x Requiem IV Intact VAULTEO 6.6 E. proflts:";

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

  function makeRewardController(shape?: {
    rarities?: readonly string[];
    chances?: readonly number[];
  }) {
    const relic = "/Lotus/Types/Game/Projections/LithTestIntact";
    const blueprint = "/Lotus/Types/Recipes/TestPrimeBlueprint";
    const ctx = {
      overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
      currentInventoryData: {
        LevelKeys: [{ ItemType: relic, ItemCount: 1 }],
        Recipes: [{ ItemType: blueprint, ItemCount: 3 }],
        PendingRecipes: [{ ItemType: blueprint }],
      } as Record<string, unknown> | null,
    };
    const prices = vi.fn(() => 5);
    const events: unknown[] = [];
    const rewards = Array.from({ length: 7 }, (_, index) => ({
      name: `Test reward ${index}`,
      uniqueName: index === 1 ? null : blueprint,
      imageUrl: "https://assets.wfhelper.com/test.png",
      urlName: `test_reward_${index}`,
      chance: shape?.chances?.[index] ?? 100 / 7,
      ducats: 15,
      rarity: shape?.rarities?.[index] ?? "Common",
    }));
    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx,
      windows: {
        createOverlayWindow: vi.fn(),
        clearOverlayAutoHideTimer: vi.fn(),
        scheduleOverlayAutoHide: vi.fn(),
        sendOverlayEvent: (channel, payload) => {
          if (channel === RELIC_RECOMMENDATIONS) events.push(payload);
        },
        positionOverlayWindow: vi.fn(),
        getAnchorMeta: () => null,
        setAnchorMeta: vi.fn(),
      },
      relicService: {
        getRelicDatabase: () => ({
          groups: {
            test: {
              key: "test",
              name: "Lith Test",
              tier: "Lith",
              qualities: { intact: { rewards } },
            },
          },
          byUniqueName: { [relic]: { groupKey: "test", quality: "intact" } },
        }),
      },
      rewardScanner: { detectRelicSelectionEra: async () => ({ era: "Lith", confidence: 1 }) },
      wfmStatsPrice: { getCachedPriceBySlug: prices },
      fs,
      cacheFilePath: makeTempSnapshot({}),
    });
    const latest = () =>
      events.at(-1) as {
        rows: Array<{
          rewards: Array<{
            ownedCount: number | null;
            name: string;
            imageUrl: string | null;
            rarity: string | null;
            chance: number;
          }>;
        }>;
      };
    const trigger = async () => {
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    return { ctx, blueprint, prices, latest, trigger };
  }

  it("refreshes reward ownership after cached ranking and subtracts foundry blueprints", async () => {
    const { ctx, blueprint, prices, latest, trigger } = makeRewardController();
    await trigger();
    const first = latest();
    expect(first.rows[0].rewards).toHaveLength(6);
    expect(first.rows[0].rewards[0]).toMatchObject({
      name: "Test reward 0",
      ownedCount: 2,
      imageUrl: "https://assets.wfhelper.com/test.png",
    });
    expect(Object.keys(first.rows[0].rewards[0]).sort()).toEqual([
      "chance",
      "imageUrl",
      "name",
      "ownedCount",
      "rarity",
    ]);
    expect(first.rows[0].rewards[1].ownedCount).toBeNull();
    const priceCalls = prices.mock.calls.length;
    ctx.currentInventoryData = {
      ...ctx.currentInventoryData,
      Recipes: [{ ItemType: blueprint, ItemCount: 5 }],
      PendingRecipes: [{ ItemType: blueprint }, { ItemType: blueprint }],
    };
    await trigger();
    expect(latest().rows[0].rewards[0].ownedCount).toBe(3);
    expect(first.rows[0].rewards[0].ownedCount).toBe(2);
    expect(prices).toHaveBeenCalledTimes(priceCalls);
  });

  it("sends the six planner rewards rarity first, then by descending chance", async () => {
    const { latest, trigger } = makeRewardController({
      rarities: ["Common", "Uncommon", "Rare", "Common", "Uncommon", "Common", "Common"],
      chances: [10, 20, 2, 11, 21, 12, 13],
    });
    await trigger();
    const rewards = latest().rows[0].rewards;
    expect(rewards.map((reward) => reward.rarity)).toEqual([
      "Rare",
      "Uncommon",
      "Uncommon",
      "Common",
      "Common",
      "Common",
    ]);
    expect(rewards.map((reward) => reward.name)).toEqual([
      "Test reward 2",
      "Test reward 4",
      "Test reward 1",
      "Test reward 6",
      "Test reward 5",
      "Test reward 3",
    ]);
  });

  it("sends each slot the rarity the overlay editor labels it with", async () => {
    const { latest, trigger } = makeRewardController({
      rarities: ["Common", "Uncommon", "Rare", "Common", "Uncommon", "Common", "Common"],
      chances: [10, 20, 2, 11, 21, 12, 13],
    });
    await trigger();
    const labels = getOverlayDescriptor("planner").labels;
    const labelled = latest().rows[0].rewards.map((_, index) =>
      labels[`reward${index}Name`].key.replace(/^overlayEditor\.field\.reward|Name$/g, ""),
    );

    expect(labelled).toEqual(latest().rows[0].rewards.map((reward) => reward.rarity));
  });

  it("keeps the source order for rewards of equal rarity and chance", async () => {
    const { latest, trigger } = makeRewardController();
    await trigger();
    expect(latest().rows[0].rewards.map((reward) => reward.name)).toEqual([
      "Test reward 0",
      "Test reward 1",
      "Test reward 2",
      "Test reward 3",
      "Test reward 4",
      "Test reward 5",
    ]);
  });

  it("does not retain cached owned recommendations when inventory becomes unavailable", async () => {
    const { ctx, latest, trigger } = makeRewardController();
    await trigger();
    expect(latest().rows).toHaveLength(1);
    ctx.currentInventoryData = null;
    await trigger();
    expect(latest().rows).toEqual([]);
  });

  it("uses component aliases without adding the same pile twice", async () => {
    const { ctx, blueprint, latest, trigger } = makeRewardController();
    ctx.currentInventoryData = {
      ...ctx.currentInventoryData,
      PendingRecipes: [],
      MiscItems: [{ ItemType: blueprint.replace("Blueprint", "Component"), ItemCount: 8 }],
    };
    await trigger();
    expect(latest().rows[0].rewards[0].ownedCount).toBe(8);
  });

  it("keeps reusable blueprints owned while their foundry build is pending", async () => {
    const { blueprint, latest, trigger } = makeRewardController();
    vi.spyOn(itemDatabase, "isReusableBlueprint").mockImplementation((name) => name === blueprint);
    await trigger();
    expect(latest().rows[0].rewards[0].ownedCount).toBe(3);
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
      // Real timers here, so the production start delay would race every assertion.
      eraStartDelayMs: 0,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
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

  it("serves reward prices from the snapshot, refusing a too-old file", () => {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {
        akarius_prime_blueprint: { status: "ok", median: 15, timestamp: Date.now() },
      },
      meta: {},
      orderSummaries: {},
    });
    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: null,
      },
      windows: {
        createOverlayWindow: vi.fn(),
        clearOverlayAutoHideTimer: vi.fn(),
        scheduleOverlayAutoHide: vi.fn(),
        sendOverlayEvent: vi.fn(),
        positionOverlayWindow: vi.fn(),
        getAnchorMeta: () => null,
        setAnchorMeta: vi.fn(),
      },
      relicService: { getRelicDatabase: () => ({ groups: {}, byUniqueName: {} }) },
      rewardScanner: { detectRelicSelectionEra: async () => ({ era: null, confidence: 0 }) },
      wfmStatsPrice: { getCachedPriceBySlug: vi.fn() },
      fs,
      cacheFilePath,
    });

    expect(controller.getSnapshotPrice("akarius_prime_blueprint")).toBe(15);
    expect(controller.getSnapshotPrice("unknown_slug")).toBeNull();

    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    fs.utimesSync(cacheFilePath, old, old);
    expect(controller.getSnapshotPrice("akarius_prime_blueprint")).toBeNull();
  });

  function makeTwoEraController(
    currentInventoryData?: Record<string, unknown>,
    extra?: { key: string; tier: string; slug: string; uniqueName: string },
  ) {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {
        lith_prize_blueprint: { status: "ok", median: 5, timestamp: Date.now() },
        akarius_prime_blueprint: { status: "ok", median: 15, timestamp: Date.now() },
      },
      meta: {},
      orderSummaries: {},
    });

    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const ocrSpy = vi.fn(
      async (): Promise<{
        era: string | null;
        confidence: number;
        candidateId?: string;
        textPreview?: string;
      }> => ({
        era: "Lith",
        confidence: 1,
      }),
    );
    const group = (name: string, tier: string, slug: string) => ({
      key: name,
      name,
      tier,
      qualities: {
        intact: {
          rewards: [{ chance: 100, urlName: slug, ducats: null, rarity: "Rare" }],
        },
      },
    });
    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: currentInventoryData ?? {
          LevelKeys: [
            { ItemType: "/Lotus/Types/Game/Projections/LithTestIntact", ItemCount: 1 },
            { ItemType: "/Lotus/Types/Game/Projections/NeoTestIntact", ItemCount: 1 },
            ...(extra ? [{ ItemType: extra.uniqueName, ItemCount: 1 }] : []),
          ],
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
            "Lith Test": group("Lith Test", "Lith", "lith_prize_blueprint"),
            "Neo Test": group("Neo Test", "Neo", "akarius_prime_blueprint"),
            ...(extra ? { [extra.key]: group(extra.key, extra.tier, extra.slug) } : {}),
          },
          byUniqueName: {
            "/Lotus/Types/Game/Projections/LithTestIntact": {
              groupKey: "Lith Test",
              quality: "intact",
            },
            "/Lotus/Types/Game/Projections/NeoTestIntact": {
              groupKey: "Neo Test",
              quality: "intact",
            },
            ...(extra ? { [extra.uniqueName]: { groupKey: extra.key, quality: "intact" } } : {}),
          },
        }),
      },
      rewardScanner: { detectRelicSelectionEra: ocrSpy },
      wfmStatsPrice: { getCachedPriceBySlug: vi.fn() },
      fs,
      cacheFilePath,
    });

    const recommendations = () =>
      sentEvents.filter((event) => event.channel === RELIC_RECOMMENDATIONS);
    const lastRecommendation = () =>
      recommendations().at(-1)?.payload as {
        era?: string | null;
        rows?: Array<{ label: string }>;
      };

    return { controller, ocrSpy, lastRecommendation, recommendations };
  }

  it("uses the shared split-stack and collection precedence rules", async () => {
    const lith = "/Lotus/Types/Game/Projections/LithTestIntact";
    const neo = "/Lotus/Types/Game/Projections/NeoTestIntact";
    const { controller, lastRecommendation } = makeTwoEraController({
      LevelKeys: [
        { ItemType: lith, ItemCount: 2 },
        { ItemType: lith, ItemCount: 3 },
      ],
      MiscItems: [
        { ItemType: lith, ItemCount: 4 },
        { ItemType: lith, ItemCount: 3 },
        { ItemType: neo, ItemCount: 0 },
      ],
      Recipes: [{ ItemType: lith, ItemCount: 1 }],
    });

    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["7x Lith Test Intact"]);
  });

  it("omnia mission tag recommends every era; tile-style OCR cannot override it", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();

    controller.setActiveMissionTag("VoidT6");
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const payload = lastRecommendation();
    expect(payload.era).toBe("omnia");
    expect(payload.rows?.map((row) => row.label).sort()).toEqual([
      "1x Lith Test Intact",
      "1x Neo Test Intact",
    ]);
    expect(ocrSpy).toHaveBeenCalledWith(expect.objectContaining({ labelOnly: true }));
  });

  it("stale mission tag yields to a confident filter-label read", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    ocrSpy.mockResolvedValue({ era: "omnia", confidence: 1, candidateId: "filter-label" });

    controller.setActiveMissionTag("VoidT1"); // lith tag lingering from the last mission
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const payload = lastRecommendation();
    expect(payload.era).toBe("omnia");
    expect(payload.rows?.map((row) => row.label).sort()).toEqual([
      "1x Lith Test Intact",
      "1x Neo Test Intact",
    ]);
    expect(ocrSpy).toHaveBeenCalledWith(expect.objectContaining({ labelOnly: true }));
  });

  it("void tag era survives picker close; non-fissure tag falls back to OCR", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();

    controller.setActiveMissionTag("VoidT3");
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Neo Test Intact"]);

    controller.resetMissionTier();
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Neo Test Intact"]);
    for (const call of ocrSpy.mock.calls) {
      expect(call).toEqual([expect.objectContaining({ labelOnly: true })]);
    }

    controller.setActiveMissionTag("EntratiHubKey");
    controller.resetMissionTier();
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ocrSpy).toHaveBeenCalled();
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);
  });

  it("mission end clears the fissure tag so the next pick trusts OCR again", async () => {
    const { controller, lastRecommendation } = makeTwoEraController();

    controller.setActiveMissionTag("VoidT6"); // omnia fissure
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().era).toBe("omnia");

    controller.setActiveMissionTag("EndOfMission");
    controller.resetMissionTier();
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastRecommendation().era).toBe("lith");
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);
  });

  it("leaves Requiem relics out of an omnia fissure", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController(undefined, {
      key: "Requiem Test",
      tier: "Requiem",
      slug: "requiem_test_mod",
      uniqueName: "/Lotus/Types/Game/Projections/RequiemTestIntact",
    });

    ocrSpy.mockResolvedValue({ era: "omnia", confidence: 1, candidateId: "filter-label" });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const labels = lastRecommendation().rows?.map((row) => row.label) ?? [];
    expect(labels.join(" ")).not.toMatch(/Requiem/);
    expect(labels.join(" ")).toMatch(/Lith Test/);
  });

  it("a Requiem label cannot override an omnia mission tag", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    controller.setActiveMissionTag("VoidT6");

    ocrSpy.mockResolvedValue({ era: "requiem", confidence: 1, candidateId: "filter-label" });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastRecommendation().era).toBe("omnia");
  });

  it("a relic tile filters its own screen without pinning the era for 25 minutes", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();

    ocrSpy.mockResolvedValue({ era: "neo", confidence: 1, candidateId: "tile-slot-1" });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().era).toBe("neo");

    ocrSpy.mockResolvedValue({ era: null, confidence: 0 });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(lastRecommendation().era).toBeNull();
  });

  it("an OCR era ages out instead of renewing itself on every pick", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    const realNow = Date.now();
    let clock = realNow;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      ocrSpy.mockResolvedValue({ era: "neo", confidence: 1, candidateId: "filter-label" });
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lastRecommendation().era).toBe("neo");

      clock += 20 * 60 * 1000;
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lastRecommendation().era).toBe("neo");

      clock += 10 * 60 * 1000;
      ocrSpy.mockResolvedValue({ era: null, confidence: 0 });
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(lastRecommendation().era).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("drops the refinement push when the player closes the overlay mid-scan", async () => {
    const { controller, ocrSpy, recommendations } = makeTwoEraController();
    ocrSpy.mockResolvedValue({ era: "lith", confidence: 1, candidateId: "filter-label" });

    await controller.onRelicSelectionTrigger("manual");
    controller.suppressReopenForClose();
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(ocrSpy).toHaveBeenCalled();
    expect(recommendations()).toHaveLength(0);
  });

  it("skips the blind retry when the first era pass spent the whole budget", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    let clock = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      ocrSpy.mockImplementation(async () => {
        clock += 2400;
        return { era: null, confidence: 0 };
      });
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(ocrSpy).toHaveBeenCalledTimes(1);
      expect(lastRecommendation().era).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("retries an empty era read once before sending unfiltered rows", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    ocrSpy.mockResolvedValueOnce({ era: null, confidence: 0 });

    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(ocrSpy).toHaveBeenCalledTimes(2);
    const payload = lastRecommendation();
    expect(payload.era).toBe("lith");
    expect(payload.rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);
  });

  function makeRequiemController() {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {},
      meta: {},
      orderSummaries: {},
    });

    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const ocrSpy = vi.fn(
      async (): Promise<{
        era: string | null;
        confidence: number;
        candidateId?: string;
        textPreview?: string;
      }> => ({ era: null, confidence: 0 }),
    );
    const group = (name: string, tier: string) => ({
      key: name,
      name,
      tier,
      qualities: { intact: { rewards: [{ chance: 100, urlName: "x", ducats: null }] } },
    });
    const uniqueName = (name: string) => `/Lotus/Types/Game/Projections/${name}Intact`;

    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: {
          LevelKeys: [
            { ItemType: uniqueName("Requiem III"), ItemCount: 29 },
            { ItemType: uniqueName("Requiem IV"), ItemCount: 29 },
            { ItemType: uniqueName("Lith Test"), ItemCount: 1 },
          ],
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
            "Requiem III": group("Requiem III", "Requiem"),
            "Requiem IV": group("Requiem IV", "Requiem"),
            "Lith Test": group("Lith Test", "Lith"),
          },
          byUniqueName: {
            [uniqueName("Requiem III")]: { groupKey: "Requiem III", quality: "intact" as const },
            [uniqueName("Requiem IV")]: { groupKey: "Requiem IV", quality: "intact" as const },
            [uniqueName("Lith Test")]: { groupKey: "Lith Test", quality: "intact" as const },
          },
        }),
      },
      rewardScanner: { detectRelicSelectionEra: ocrSpy },
      wfmStatsPrice: { getCachedPriceBySlug: vi.fn() },
      fs,
      cacheFilePath,
    });

    const lastRecommendation = () =>
      sentEvents.filter((event) => event.channel === RELIC_RECOMMENDATIONS).at(-1)?.payload as {
        era?: string | null;
        rows?: Array<{ label: string }>;
      };

    return { controller, ocrSpy, lastRecommendation };
  }

  it("drops an era read that only matched the planner overlay's own cards", async () => {
    expect(detectRelicEraFromBandText(OWN_OVERLAY_BAND).era).toBe("requiem");

    const { controller, ocrSpy, lastRecommendation } = makeRequiemController();

    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: "REQUIEM RELICS",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      lastRecommendation()
        .rows?.map((row) => row.label)
        .sort(),
    ).toEqual(["29x Requiem III Intact", "29x Requiem IV Intact"]);

    controller.resetMissionTier();
    ocrSpy.mockClear();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: OWN_OVERLAY_BAND,
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(ocrSpy).toHaveBeenCalledTimes(2);
    const payload = lastRecommendation();
    expect(payload.era).toBeNull();
    expect(payload.rows?.map((row) => row.label).sort()).toEqual([
      "1x Lith Test Intact",
      "29x Requiem III Intact",
      "29x Requiem IV Intact",
    ]);
  });

  it("keeps a genuine single-era read while overlay rows are on screen", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeRequiemController();

    ocrSpy.mockResolvedValue({
      era: "lith",
      confidence: 1,
      candidateId: "filter-label",
      textPreview: "LITH RELICS",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);

    controller.resetMissionTier();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "filter-label",
      textPreview: "REQUIEM 1x Lith Test Relic Intact",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastRecommendation().era).toBe("requiem");
    expect(
      lastRecommendation()
        .rows?.map((row) => row.label)
        .sort(),
    ).toEqual(["29x Requiem III Intact", "29x Requiem IV Intact"]);
  });

  function makeManyRowController(rowCount: number) {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {},
      meta: {},
      orderSummaries: {},
    });

    const names = Array.from(
      { length: rowCount },
      (_unused, index) => `Requiem A${String(index + 1).padStart(2, "0")}`,
    );
    const uniqueName = (name: string) => `/Lotus/Types/Game/Projections/${name}Intact`;
    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const ocrSpy = vi.fn(
      async (): Promise<{
        era: string | null;
        confidence: number;
        candidateId?: string;
        textPreview?: string;
      }> => ({ era: null, confidence: 0 }),
    );

    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: {
          LevelKeys: names.map((name) => ({ ItemType: uniqueName(name), ItemCount: 1 })),
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
          groups: Object.fromEntries(
            names.map((name) => [
              name,
              {
                key: name,
                name,
                tier: "Requiem",
                qualities: { intact: { rewards: [{ chance: 100, urlName: "x", ducats: null }] } },
              },
            ]),
          ),
          byUniqueName: Object.fromEntries(
            names.map((name) => [uniqueName(name), { groupKey: name, quality: "intact" as const }]),
          ),
        }),
      },
      rewardScanner: { detectRelicSelectionEra: ocrSpy },
      wfmStatsPrice: { getCachedPriceBySlug: vi.fn() },
      fs,
      cacheFilePath,
    });

    const lastRecommendation = () =>
      sentEvents.filter((event) => event.channel === RELIC_RECOMMENDATIONS).at(-1)?.payload as {
        era?: string | null;
        rows?: Array<{ label: string }>;
      };

    return { controller, ocrSpy, lastRecommendation, names };
  }

  it("rejects a self-read of any row it painted", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeManyRowController(40);

    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: "REQUIEM RELICS",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const painted = lastRecommendation().rows?.map((row) => row.label) ?? [];
    expect(painted).toHaveLength(40);

    controller.resetMissionTier();
    ocrSpy.mockClear();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: `${painted[0]} VAULTEO 6.6 E. proflts:`,
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(ocrSpy).toHaveBeenCalledTimes(2);
    expect(lastRecommendation().era).toBeNull();

    controller.resetMissionTier();
    ocrSpy.mockClear();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: `${painted[39]} VAULTEO 6.6 E. proflts:`,
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(ocrSpy).toHaveBeenCalledTimes(2);
    expect(lastRecommendation().era).toBeNull();
  });

  it("a fissure list naming several eras never reaches the planner", () => {
    expect(detectRelicEraFromBandText(STAR_CHART_FISSURE_LIST)).toEqual({
      era: null,
      confidence: 0,
    });
  });

  function makePlannerFilterController() {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {
        braton_prime_blueprint: { status: "ok", median: 10, timestamp: Date.now() },
        saryn_prime_chassis: { status: "ok", median: 30, timestamp: Date.now() },
        forma_blueprint: { status: "ok", median: 1, timestamp: Date.now() },
        akarius_prime_blueprint: { status: "ok", median: 25, timestamp: Date.now() },
      },
      meta: {},
      orderSummaries: {},
    });

    const reward = (name: string, urlName: string, chance: number, ducats: number) => ({
      name,
      uniqueName: null,
      imageUrl: null,
      urlName,
      chance,
      ducats,
      rarity: "Rare",
    });
    const sentEvents: Array<{ channel: string; payload: unknown }> = [];

    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: {
          LevelKeys: [
            { ItemType: "/Lotus/Relics/LithAlphaIntact", ItemCount: 2 },
            { ItemType: "/Lotus/Relics/LithAlphaRadiant", ItemCount: 1 },
            { ItemType: "/Lotus/Relics/LithBravoIntact", ItemCount: 5 },
            { ItemType: "/Lotus/Relics/LithCharlieIntact", ItemCount: 1 },
          ],
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
            "Lith Alpha": {
              key: "Lith Alpha",
              name: "Lith Alpha",
              tier: "Lith",
              vaulted: false,
              qualities: {
                intact: {
                  rewards: [
                    reward("Braton Prime Blueprint", "braton_prime_blueprint", 50, 15),
                    reward("Saryn Prime Chassis", "saryn_prime_chassis", 50, 100),
                  ],
                },
                radiant: {
                  rewards: [reward("Saryn Prime Chassis", "saryn_prime_chassis", 100, 100)],
                },
              },
            },
            "Lith Bravo": {
              key: "Lith Bravo",
              name: "Lith Bravo",
              tier: "Lith",
              vaulted: true,
              qualities: {
                intact: { rewards: [reward("Forma Blueprint", "forma_blueprint", 100, 5)] },
              },
            },
            "Lith Charlie": {
              key: "Lith Charlie",
              name: "Lith Charlie",
              tier: "Lith",
              vaulted: false,
              qualities: {
                intact: {
                  rewards: [reward("Akarius Prime Blueprint", "akarius_prime_blueprint", 100, 20)],
                },
                radiant: {
                  rewards: [reward("Akarius Prime Blueprint", "akarius_prime_blueprint", 100, 20)],
                },
              },
            },
          },
          byUniqueName: {
            "/Lotus/Relics/LithAlphaIntact": { groupKey: "Lith Alpha", quality: "intact" as const },
            "/Lotus/Relics/LithAlphaRadiant": {
              groupKey: "Lith Alpha",
              quality: "radiant" as const,
            },
            "/Lotus/Relics/LithBravoIntact": { groupKey: "Lith Bravo", quality: "intact" as const },
            "/Lotus/Relics/LithCharlieIntact": {
              groupKey: "Lith Charlie",
              quality: "intact" as const,
            },
          },
        }),
      },
      rewardScanner: {
        detectRelicSelectionEra: async () => ({ era: "Lith", confidence: 1 }),
      },
      wfmStatsPrice: { getCachedPriceBySlug: vi.fn() },
      fs,
      cacheFilePath,
    });

    const push = (overrides: Record<string, unknown> = {}) =>
      controller.setDesktopFilters({
        squadSize: 1,
        search: "",
        containsNeededReward: false,
        vaultedMode: "all",
        qualityMode: "owned",
        sortMode: "tier",
        sortDirection: "asc",
        tierFilter: null,
        neededRewardKeys: null,
        pinnedQualities: {},
        ...overrides,
      });

    const rows = async () => {
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const payload = sentEvents.filter((event) => event.channel === RELIC_RECOMMENDATIONS).at(-1)
        ?.payload as {
        rows?: Array<{ label: string; platEv: number | null; count: number; quality: string }>;
      };
      return payload.rows ?? [];
    };
    const labels = async () => (await rows()).map((row) => row.label);

    return { controller, push, rows, labels };
  }

  it("keeps its own expected-value ordering until the planner pushes", async () => {
    const { labels } = makePlannerFilterController();
    expect(await labels()).toEqual([
      "1x Lith Alpha Radiant",
      "1x Lith Charlie Intact",
      "5x Lith Bravo Intact",
    ]);
  });

  it("orders overlay rows by the pushed sort mode and direction", async () => {
    const { push, labels } = makePlannerFilterController();

    push({ sortMode: "name", sortDirection: "asc" });
    expect(await labels()).toEqual([
      "1x Lith Alpha Radiant",
      "5x Lith Bravo Intact",
      "1x Lith Charlie Intact",
    ]);

    push({ sortMode: "ducat", sortDirection: "desc" });
    expect(await labels()).toEqual([
      "1x Lith Alpha Radiant",
      "1x Lith Charlie Intact",
      "5x Lith Bravo Intact",
    ]);

    push({ sortMode: "ducatonator", sortDirection: "desc" });
    expect(await labels()).toEqual([
      "5x Lith Bravo Intact",
      "1x Lith Alpha Radiant",
      "1x Lith Charlie Intact",
    ]);
  });

  it("counts every owned grade for the owned sort, like the planner card does", async () => {
    const { push, labels } = makePlannerFilterController();
    push({ sortMode: "owned", sortDirection: "desc" });
    expect(await labels()).toEqual([
      "5x Lith Bravo Intact",
      "1x Lith Alpha Radiant",
      "1x Lith Charlie Intact",
    ]);
  });

  it("shows the grade the pushed quality mode selects", async () => {
    const { push, rows } = makePlannerFilterController();

    push({ qualityMode: "intact" });
    const intact = (await rows()).find((row) => row.label.includes("Alpha"));
    expect(intact).toMatchObject({ label: "2x Lith Alpha Intact", quality: "intact", platEv: 20 });

    push({ qualityMode: "radiant" });
    const radiant = (await rows()).find((row) => row.label.includes("Alpha"));
    expect(radiant).toMatchObject({ label: "1x Lith Alpha Radiant", quality: "radiant" });
  });

  it("offers the owned grades of a relic the pushed grade has no copy of", async () => {
    const { push, labels } = makePlannerFilterController();

    push({ qualityMode: "radiant" });
    expect(await labels()).toEqual([
      "1x Lith Alpha Radiant",
      "5x Lith Bravo Intact",
      "1x Lith Charlie Intact",
    ]);
  });

  it("follows the grade pinned on the planner card in owned mode", async () => {
    const { push, rows } = makePlannerFilterController();

    push({ pinnedQualities: { "Lith Alpha": "intact" }, sortMode: "ev", sortDirection: "desc" });
    const pinned = await rows();
    expect(pinned.find((row) => row.label.includes("Alpha"))).toMatchObject({
      label: "2x Lith Alpha Intact",
      quality: "intact",
      platEv: 20,
    });
    expect(pinned.map((row) => row.label)).toEqual([
      "1x Lith Charlie Intact",
      "2x Lith Alpha Intact",
      "5x Lith Bravo Intact",
    ]);
  });

  it("applies the pushed squad size to the expected value", async () => {
    const { push, rows } = makePlannerFilterController();

    push({ qualityMode: "intact", squadSize: 4 });
    const alpha = (await rows()).find((row) => row.label.includes("Alpha"));
    expect(alpha?.platEv).toBeCloseTo(28.75, 5);
  });

  it("applies the pushed vaulted mode", async () => {
    const { push, labels } = makePlannerFilterController();

    push({ vaultedMode: "vaulted" });
    expect(await labels()).toEqual(["5x Lith Bravo Intact"]);
  });

  it("applies the pushed copies threshold over every owned grade", async () => {
    const { push, labels } = makePlannerFilterController();

    // Alpha shows its single radiant copy but owns three in total.
    push({ ownedAbove: 2, sortMode: "name" });
    expect(await labels()).toEqual(["1x Lith Alpha Radiant", "5x Lith Bravo Intact"]);
  });

  it("applies the pushed search text to relic and reward names", async () => {
    const { push, labels } = makePlannerFilterController();

    push({ search: "saryn" });
    expect(await labels()).toEqual(["1x Lith Alpha Radiant"]);

    push({ search: "charlie" });
    expect(await labels()).toEqual(["1x Lith Charlie Intact"]);

    push({ search: "radiant" });
    expect(await labels()).toEqual(["1x Lith Alpha Radiant"]);

    push({ search: "nothing here" });
    expect(await labels()).toEqual([]);
  });

  it("keeps only the relics the planner's needed-reward engine listed", async () => {
    const { push, labels } = makePlannerFilterController();

    push({ containsNeededReward: true, neededRewardKeys: ["Lith Charlie"] });
    expect(await labels()).toEqual(["1x Lith Charlie Intact"]);

    push({ containsNeededReward: true, neededRewardKeys: [] });
    expect(await labels()).toEqual([]);

    push({ containsNeededReward: false, neededRewardKeys: null, sortMode: "name" });
    expect(await labels()).toEqual([
      "1x Lith Alpha Radiant",
      "5x Lith Bravo Intact",
      "1x Lith Charlie Intact",
    ]);
  });

  it("holds an invalid field at the value already in effect", async () => {
    const { controller, push, labels } = makePlannerFilterController();

    push({ sortMode: "name", sortDirection: "desc", squadSize: 3 });
    controller.setDesktopFilters({ sortMode: "chaos", squadSize: 99, vaultedMode: 7 });
    expect(await labels()).toEqual([
      "1x Lith Charlie Intact",
      "5x Lith Bravo Intact",
      "1x Lith Alpha Radiant",
    ]);
  });

  it("ignores a payload that is not a record instead of falling back to defaults", async () => {
    const { controller, push, labels } = makePlannerFilterController();

    push({
      sortMode: "name",
      sortDirection: "asc",
      containsNeededReward: true,
      neededRewardKeys: ["Lith Alpha", "Lith Bravo"],
      pinnedQualities: { "Lith Alpha": "intact" },
    });
    for (const payload of [["sortMode", "name"], [], null, "sortMode=name", 7]) {
      controller.setDesktopFilters(payload);
    }
    expect(await labels()).toEqual(["2x Lith Alpha Intact", "5x Lith Bravo Intact"]);
  });
});
