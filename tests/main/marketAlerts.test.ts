import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

const mocks = vi.hoisted(() => ({
  requestMock: vi.fn<(method: string, path: string, opts?: unknown) => Promise<unknown>>(),
  requestV2Mock: vi.fn<(method: string, path: string, opts?: unknown) => Promise<unknown>>(),
  healthMock: vi.fn<() => { state: "ok" | "backoff" | "degraded"; recentFailures: number }>(),
  dispatchMock: vi.fn(
    (_payload: { source: string; title: string; body: string }, deliverNative?: () => void) => {
      deliverNative?.();
    },
  ),
  catalogSlugMock: vi.fn(async (_slug: string) => null as { item_name: string } | null),
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

vi.mock("../../services/wfmClient", () => ({
  request: mocks.requestMock,
  requestV2: mocks.requestV2Mock,
}));

vi.mock("../../services/wfmScheduler", () => ({
  getWfmSchedulerHealth: mocks.healthMock,
}));

vi.mock("../../services/notificationChannels", () => ({
  dispatch: mocks.dispatchMock,
}));

vi.mock("../../services/wfmCatalog", () => ({
  lookupBySlug: mocks.catalogSlugMock,
}));

import {
  clearMarketAlertCooldown,
  clearMarketAlertHits,
  deleteMarketAlertRule,
  exportMarketAlertRules,
  getMarketAlertCooldowns,
  getMarketAlertEngineStatus,
  getMarketAlertHits,
  importMarketAlertRules,
  initMarketAlerts,
  listMarketAlertRules,
  resetMarketAlertsForTest,
  runMarketAlertTickForTest,
  saveMarketAlertRule,
  setMarketAlertRuleEnabled,
  stopMarketAlerts,
  testFireMarketAlertRule,
} from "../../services/marketAlerts";

const deliverMock = vi.fn();
const changedMock = vi.fn();
let ownName: string | null = null;
let liveOwned: Record<string, number> = {};

function initEngine(): void {
  initMarketAlerts({
    deliverNative: deliverMock,
    getOwnName: () => ownName,
    getLiveOwnedCount: (slug) => Promise.resolve(liveOwned[slug] ?? null),
    onChanged: changedMock,
  });
}

interface AuctionSpec {
  id?: string;
  seller?: string;
  status?: string;
  buyout?: number | null;
  starting?: number | null;
  mastery?: number;
  modRank?: number;
  rerolls?: number;
  polarity?: string;
  attributes?: Array<{ url_name: string; value: number; positive: boolean }>;
}

function auctionPayload(specs: AuctionSpec[]): unknown {
  return {
    payload: {
      auctions: specs.map((spec, index) => ({
        id: spec.id ?? `auction-${index}`,
        owner: { ingame_name: spec.seller ?? "SellerOne", status: spec.status ?? "ingame" },
        buyout_price: spec.buyout === undefined ? 100 : spec.buyout,
        starting_price: spec.starting ?? null,
        is_direct_sell: true,
        item: {
          name: "test riven",
          weapon_url_name: "rubico",
          re_rolls: spec.rerolls ?? 5,
          mastery_level: spec.mastery ?? 14,
          mod_rank: spec.modRank ?? 8,
          polarity: spec.polarity ?? "madurai",
          attributes: spec.attributes ?? [
            { url_name: "critical_chance", value: 120, positive: true },
            { url_name: "critical_damage", value: 90, positive: true },
            { url_name: "zoom", value: -40, positive: false },
          ],
        },
      })),
    },
  };
}

interface OrderSpec {
  id?: string;
  owner?: string;
  status?: string;
  type?: string;
  platinum?: number;
  quantity?: number;
  visible?: boolean;
  platform?: string;
  legacyPlatform?: string;
  crossplay?: boolean;
}

function ordersPayload(specs: OrderSpec[]): unknown {
  return {
    data: specs.map((spec, index) => ({
      id: spec.id ?? `order-${index}`,
      type: spec.type ?? "sell",
      platinum: spec.platinum ?? 40,
      quantity: spec.quantity ?? 1,
      visible: spec.visible ?? true,
      ...(spec.legacyPlatform ? { platform: spec.legacyPlatform } : {}),
      user: {
        ingameName: spec.owner ?? "OtherUser",
        status: spec.status ?? "ingame",
        ...(spec.platform ? { platform: spec.platform } : {}),
        ...(spec.crossplay ? { crossplay: true } : {}),
      },
    })),
  };
}

function rivenRuleRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { riven, ...rest } = overrides;
  return {
    id: "rule-riven",
    name: "Crit Rubico",
    kind: "riven",
    cooldownMinutes: 60,
    ...rest,
    riven: {
      weaponUrlName: "rubico",
      requirePositive: ["critical_chance"],
      ...(riven as Record<string, unknown> | undefined),
    },
  };
}

function itemRuleRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { item, ...rest } = overrides;
  return {
    id: "rule-item",
    name: "Cheap Set",
    kind: "item",
    cooldownMinutes: 60,
    ...rest,
    item: {
      itemUrlName: "nekros_prime_set",
      side: "sell",
      maxPlatinum: 50,
      statuses: ["ingame"],
      ...(item as Record<string, unknown> | undefined),
    },
  };
}

function saveOk(raw: Record<string, unknown>, ownedCount: number | null = null): void {
  const result = saveMarketAlertRule(raw, { native: true }, ownedCount);
  if (!result.ok) throw new Error(result.error);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "market-alerts-"));
  mocks.requestMock.mockReset();
  mocks.requestV2Mock.mockReset();
  mocks.healthMock.mockReset();
  mocks.healthMock.mockReturnValue({ state: "ok", recentFailures: 0 });
  mocks.dispatchMock.mockClear();
  deliverMock.mockClear();
  changedMock.mockClear();
  ownName = null;
  liveOwned = {};
  resetMarketAlertsForTest();
});

afterEach(() => {
  resetMarketAlertsForTest();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("riven rule evaluation", () => {
  it("fires on a matching auction and records a hit with endo per plat", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        { id: "abc123", buyout: 100, mastery: 13, modRank: 0, rerolls: 0, status: "Online" },
      ]),
    );
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();

    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchMock.mock.calls[0][0].source).toBe("marketAlerts");
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const hits = getMarketAlertHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe("https://warframe.market/auction/abc123");
    expect(hits[0].platinum).toBe(100);
    // MR13 r0 0 rolls dissolves for 515 endo.
    expect(hits[0].endo).toBe(515);
    expect(hits[0].endoPerPlat).toBeCloseTo(5.2, 1);
    expect(hits[0].sellerStatus).toBe("online");
  });

  it("keeps every seller when the riven rule names no status", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        { id: "a", seller: "InGameSeller", status: "ingame" },
        { id: "b", seller: "OnlineSeller", status: "online" },
        { id: "c", seller: "OfflineSeller", status: "offline" },
      ]),
    );
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(
      getMarketAlertHits()
        .map((hit) => hit.seller)
        .sort(),
    ).toEqual(["InGameSeller", "OfflineSeller", "OnlineSeller"]);
  });

  it("filters riven auctions by the rule's seller statuses", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        { id: "a", seller: "InGameSeller", status: "InGame" },
        { id: "b", seller: "OnlineSeller", status: "online" },
        { id: "c", seller: "OfflineSeller", status: "offline" },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { statuses: ["ingame"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(getMarketAlertHits().map((hit) => hit.seller)).toEqual(["InGameSeller"]);

    resetMarketAlertsForTest();
    saveOk(rivenRuleRaw({ riven: { statuses: ["ingame", "online"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(
      getMarketAlertHits()
        .map((hit) => hit.seller)
        .sort(),
    ).toEqual(["InGameSeller", "OnlineSeller"]);
  });

  it("leads the hit with every stat on the roll, curses signed by the flag", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "abc123", buyout: 100 }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();

    const hits = getMarketAlertHits();
    expect(hits[0].detail).toBe(
      "+120% Critical Chance, +90% Critical Damage, -40% Zoom - 100p - MR14 r8 5 rerolls - " +
        "7353 endo (73.5/plat)",
    );
  });

  it("matches attributes by exact url_name, never substring", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          attributes: [{ url_name: "critical_chance_on_slide_attack", value: 100, positive: true }],
        },
      ]),
    );
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("matches a shared alias-map slug carried by a melee roll", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          attributes: [{ url_name: "base_damage_/_melee_damage", value: 150, positive: true }],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { requirePositive: ["base_damage_/_melee_damage"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a curse inside allowedNegatives", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "tolerated" }]));
    saveOk(rivenRuleRaw({ riven: { allowedNegatives: ["zoom", "recoil"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("demands a curse through hasNegative plus the allowed list", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "required-curse" }]));
    saveOk(rivenRuleRaw({ riven: { hasNegative: true, allowedNegatives: ["zoom"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);

    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          id: "other-curse",
          attributes: [
            { url_name: "critical_chance", value: 120, positive: true },
            { url_name: "critical_damage", value: 90, positive: true },
            { url_name: "recoil", value: -40, positive: false },
          ],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { hasNegative: true, allowedNegatives: ["zoom"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("matches only the buff count a 2p1n rule asks for", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "two-plus-one" }]));
    saveOk(rivenRuleRaw({ riven: { positiveCount: 2, hasNegative: true } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);

    mocks.dispatchMock.mockClear();
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          id: "three-plus-one",
          attributes: [
            { url_name: "critical_chance", value: 120, positive: true },
            { url_name: "critical_damage", value: 90, positive: true },
            { url_name: "multishot", value: 60, positive: true },
            { url_name: "zoom", value: -40, positive: false },
          ],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { positiveCount: 2, hasNegative: true } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("rejects a curse the rule excludes and keeps the same stat as a buff", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "cursed" }]));
    saveOk(rivenRuleRaw({ riven: { excludeNegatives: ["zoom"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();

    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          id: "buffed",
          attributes: [
            { url_name: "critical_chance", value: 120, positive: true },
            { url_name: "zoom", value: 40, positive: true },
          ],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { excludeNegatives: ["zoom"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a curse outside allowedNegatives", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "harmful" }]));
    saveOk(rivenRuleRaw({ riven: { allowedNegatives: ["recoil"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("accepts a curse-free roll under allowedNegatives", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          id: "clean",
          attributes: [{ url_name: "critical_chance", value: 120, positive: true }],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { allowedNegatives: ["recoil"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("pushes server-side filters into the search query", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    saveOk(
      rivenRuleRaw({
        riven: {
          requirePositive: ["critical_chance", "critical_damage"],
          hasNegative: true,
          allowedNegatives: ["zoom"],
          polarity: "madurai",
          minMasteryRank: 9,
          maxMasteryRank: 15,
          minRerolls: 1,
          maxRerolls: 50,
        },
      }),
    );
    initEngine();
    await runMarketAlertTickForTest();
    const requestPath = mocks.requestMock.mock.calls[0][1];
    expect(requestPath).toContain("weapon_url_name=rubico");
    // Comma list, which WFM parses as AND; repeated keys honour only the first.
    expect(requestPath).toContain("positive_stats=critical_chance%2Ccritical_damage");
    expect(requestPath).toContain("negative_stats=zoom");
    expect(requestPath).toContain("polarity=madurai");
    expect(requestPath).toContain("mastery_rank_min=9");
    expect(requestPath).toContain("mastery_rank_max=15");
    expect(requestPath).toContain("re_rolls_min=1");
    // WFM ignores `similarity` outright, so it is never sent.
    expect(requestPath).not.toContain("similarity=");
    expect(mocks.requestMock.mock.calls[0][2]).toEqual({ priority: "background" });
  });

  it("keeps a two-curse whitelist out of the query and filters it locally", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    saveOk(rivenRuleRaw({ riven: { hasNegative: true, allowedNegatives: ["zoom", "recoil"] } }));
    initEngine();
    await runMarketAlertTickForTest();

    const requestPath = mocks.requestMock.mock.calls[0][1] as string;
    expect(requestPath).not.toContain("negative_stats=");
  });

  it("stops pushing positive_stats once similarity allows a partial match", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    saveOk(
      rivenRuleRaw({
        riven: {
          requirePositive: ["critical_chance", "critical_damage"],
          minSimilarityPct: 50,
        },
      }),
    );
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock.mock.calls[0][1]).not.toContain("positive_stats");
  });

  it("applies similarity as the share of required stats present", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        { id: "half", attributes: [{ url_name: "critical_chance", value: 100, positive: true }] },
      ]),
    );
    saveOk(
      rivenRuleRaw({
        id: "rule-50",
        riven: {
          requirePositive: ["critical_chance", "critical_damage"],
          minSimilarityPct: 50,
        },
      }),
    );
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);

    resetMarketAlertsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    mocks.dispatchMock.mockClear();
    saveOk(
      rivenRuleRaw({
        id: "rule-60",
        riven: {
          requirePositive: ["critical_chance", "critical_damage"],
          minSimilarityPct: 60,
        },
      }),
    );
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("applies stat-value bounds and endo-per-plat locally", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        { id: "good", buyout: 100 },
        {
          id: "weak",
          attributes: [{ url_name: "critical_chance", value: 80, positive: true }],
        },
        { id: "pricey", buyout: 10_000 },
      ]),
    );
    saveOk(
      rivenRuleRaw({
        riven: {
          statBounds: [{ attribute: "critical_chance", min: 100 }],
          minEndoPerPlat: 50,
        },
      }),
    );
    initEngine();
    await runMarketAlertTickForTest();
    const hits = getMarketAlertHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toContain("good");
  });

  it("compares stat bounds at max rank, not at the listing's rank", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        // 24.4% crit on an unranked riven is 219.6% at rank 8.
        {
          id: "unranked",
          modRank: 0,
          attributes: [{ url_name: "critical_chance", value: 24.4, positive: true }],
        },
        {
          id: "weak",
          modRank: 8,
          attributes: [{ url_name: "critical_chance", value: 10, positive: true }],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { statBounds: [{ attribute: "critical_chance", min: 100 }] } }));
    initEngine();
    await runMarketAlertTickForTest();
    const hits = getMarketAlertHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toContain("unranked");
  });

  it("treats a missing bounded stat as a non-match", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          id: "no-cd",
          attributes: [{ url_name: "critical_chance", value: 150, positive: true }],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { statBounds: [{ attribute: "critical_damage", min: 50 }] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("skips bid-only auctions unless the rule opts in, and says so when it does", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([{ id: "bid", buyout: null, starting: 50 }]),
    );
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();

    saveOk(rivenRuleRaw({ id: "rule-bid", riven: { includeBidOnly: true } }));
    await runMarketAlertTickForTest();
    const hits = getMarketAlertHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("50p starting bid");
  });

  it("excludes the signed-in user's own auctions case-insensitively", async () => {
    ownName = "MyAccount";
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        { id: "mine", seller: "myaccount" },
        { id: "theirs", seller: "SomeoneElse" },
      ]),
    );
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    const hits = getMarketAlertHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toContain("theirs");
  });

  it("honors required negative and hasNegative gates", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        {
          id: "no-curse",
          attributes: [{ url_name: "critical_chance", value: 120, positive: true }],
        },
      ]),
    );
    saveOk(rivenRuleRaw({ riven: { hasNegative: true } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });
});

describe("cooldown and dedup", () => {
  it("stays quiet through the cooldown, then dedups already-seen listings", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(56 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertHits()).toHaveLength(1);
  });

  it("reports the running cooldown and clears it on demand", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeGreaterThan(Date.now());

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);

    expect(clearMarketAlertCooldown("rule-riven")).toBe(true);
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeUndefined();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "second" }]));
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("starts no quiet window for a no-cooldown rule, but still dedups", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    saveOk(rivenRuleRaw({ noCooldown: true }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeUndefined();

    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "second" }]));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(2);
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock.mock.calls.length).toBeGreaterThan(2);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a running cooldown when the rule is saved with the window off", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeGreaterThan(Date.now());

    saveOk(rivenRuleRaw({ noCooldown: true }));
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeUndefined();

    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "second" }]));
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the quiet window for a rules file written before the toggle existed", async () => {
    vi.useFakeTimers();
    fs.writeFileSync(
      path.join(tmpDir, "market-alert-rules.json"),
      JSON.stringify({
        schema: 1,
        rules: [
          {
            id: "rule-riven",
            name: "Legacy Boar",
            kind: "riven",
            enabled: true,
            cooldownMinutes: 60,
            riven: {
              weaponUrlName: "rubico",
              requirePositive: ["critical_chance"],
              excludeAttributes: [],
              statBounds: [],
            },
          },
        ],
        bindings: { "rule-riven": { native: true } },
        ownedCounts: {},
      }),
      "utf8",
    );

    expect(listMarketAlertRules().rules[0].noCooldown).toBe(false);
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    initEngine();
    await runMarketAlertTickForTest();
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeGreaterThan(Date.now());
  });

  it("refuses to clear the cooldown of a rule it does not have", () => {
    saveOk(rivenRuleRaw());
    expect(clearMarketAlertCooldown("no-such-rule")).toBe(false);
  });

  it("clears the cooldown when a rule is switched back on", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);

    setMarketAlertRuleEnabled("rule-riven", false);
    setMarketAlertRuleEnabled("rule-riven", true);
    expect(getMarketAlertCooldowns()["rule-riven"]).toBeUndefined();

    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "second" }]));
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("re-evaluates a rule edited during its cooldown", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    saveOk(rivenRuleRaw({ riven: { maxPlatinum: 30 } }));
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(2);
  });

  it("does not re-fire old hits after a restart", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "persisted" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);

    resetMarketAlertsForTest();
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertHits()).toHaveLength(1);
  });

  it("re-fires when the same listing drops in price", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "same", buyout: 100 }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);

    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "same", buyout: 60 }]));
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the hit history bounded", async () => {
    const many = Array.from({ length: 600 }, (_v, i) => ({ id: `bulk-${i}` }));
    mocks.requestMock.mockResolvedValue(auctionPayload(many));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(getMarketAlertHits()).toHaveLength(500);
  });
});

describe("item rule evaluation", () => {
  it("fires on an order inside the price bounds with the right side and status", async () => {
    mocks.requestV2Mock.mockResolvedValue(
      ordersPayload([
        { id: "cheap", platinum: 30 },
        { id: "expensive", platinum: 80 },
        { id: "buyer", type: "buy", platinum: 20 },
        { id: "offline-ish", platinum: 25, status: "online" },
        { id: "hidden", platinum: 10, visible: false },
        { id: "console", platinum: 10, platform: "ps4" },
      ]),
    );
    saveOk(itemRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    const hits = getMarketAlertHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("30p");
    expect(mocks.requestV2Mock.mock.calls[0][1]).toBe("/orders/item/nekros_prime_set");
    expect(mocks.requestMock).not.toHaveBeenCalled();
  });

  it("widens a legacy online-only item rule to in game or online", async () => {
    mocks.requestV2Mock.mockResolvedValue(
      ordersPayload([
        { id: "ingame", owner: "InGameSeller", platinum: 30, status: "ingame" },
        { id: "online", owner: "OnlineSeller", platinum: 31, status: "online" },
        { id: "offline", owner: "OfflineSeller", platinum: 32, status: "offline" },
      ]),
    );
    saveOk(itemRuleRaw({ item: { statuses: ["online"] } }));
    initEngine();
    await runMarketAlertTickForTest();
    expect(
      getMarketAlertHits()
        .map((hit) => hit.seller)
        .sort(),
    ).toEqual(["InGameSeller", "OnlineSeller"]);
  });

  it("names the item the way warframe.market does", async () => {
    mocks.catalogSlugMock.mockResolvedValue({ item_name: "Nekros Prime Set" });
    mocks.requestV2Mock.mockResolvedValue(ordersPayload([{ id: "cheap", platinum: 30 }]));
    saveOk(itemRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();

    expect(getMarketAlertHits()[0].detail).toBe("WTS Nekros Prime Set 30p x1");
  });

  it("un-slugs the name when the catalog has no entry", async () => {
    mocks.catalogSlugMock.mockResolvedValue(null);
    mocks.requestV2Mock.mockResolvedValue(ordersPayload([{ id: "cheap", platinum: 30 }]));
    saveOk(itemRuleRaw({ item: { itemUrlName: "arcane_hot_shot" } }));
    initEngine();
    await runMarketAlertTickForTest();

    expect(getMarketAlertHits()[0].detail).toBe("WTS Arcane Hot Shot 30p x1");
  });

  it("skips other-platform sellers and keeps pc and unlabelled ones", async () => {
    mocks.requestV2Mock.mockResolvedValue(
      ordersPayload([
        { id: "console", owner: "ConsoleSeller", platinum: 20, platform: "ps4" },
        { id: "legacy-console", owner: "LegacySeller", platinum: 21, legacyPlatform: "xbox" },
        { id: "pc", owner: "PcSeller", platinum: 22, platform: "PC" },
        { id: "unlabelled", owner: "QuietSeller", platinum: 23 },
        { id: "cross", owner: "CrossSeller", platinum: 24, platform: "xbox", crossplay: true },
      ]),
    );
    saveOk(itemRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    const sellers = getMarketAlertHits().map((hit) => hit.seller);
    expect(sellers.sort()).toEqual(["CrossSeller", "PcSeller", "QuietSeller"]);
  });

  it("reads a mixed-case side and status through the shared order parsers", async () => {
    mocks.requestV2Mock.mockResolvedValue(
      ordersPayload([
        { id: "shouty", owner: "LoudSeller", platinum: 30, type: "Sell", status: "InGame" },
      ]),
    );
    saveOk(itemRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    const hits = getMarketAlertHits();
    expect(hits).toHaveLength(1);
    expect(hits[0].seller).toBe("LoudSeller");
    expect(hits[0].sellerStatus).toBe("ingame");
  });

  it("excludes the user's own orders", async () => {
    ownName = "TraderMe";
    mocks.requestV2Mock.mockResolvedValue(
      ordersPayload([{ id: "mine", owner: "traderme", platinum: 10 }]),
    );
    saveOk(itemRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("applies owned-count gates from the renderer-supplied count", async () => {
    mocks.requestV2Mock.mockResolvedValue(ordersPayload([{ id: "o1", platinum: 30 }]));
    saveOk(itemRuleRaw({ item: { ownedBelow: 2 } }), 3);
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();

    saveOk(itemRuleRaw({ item: { ownedBelow: 5 } }), 3);
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("fails open when no owned count was ever pushed", async () => {
    mocks.requestV2Mock.mockResolvedValue(ordersPayload([{ id: "o1", platinum: 30 }]));
    saveOk(itemRuleRaw({ item: { ownedBelow: 2 } }), null);
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers the live owned count over the save-time snapshot", async () => {
    vi.useFakeTimers();
    mocks.requestV2Mock.mockResolvedValue(ordersPayload([{ id: "o1", platinum: 30 }]));
    saveOk(itemRuleRaw({ item: { ownedBelow: 2 } }), 5);
    liveOwned = { nekros_prime_set: 5 };
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();

    liveOwned = { nekros_prime_set: 1 };
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the owned-count snapshot when the last rule using it is deleted", () => {
    saveOk(itemRuleRaw({ item: { ownedBelow: 2 } }), 3);
    const stateFile = path.join(tmpDir, "market-alert-rules.json");
    const before = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      ownedCounts: Record<string, number>;
    };
    expect(before.ownedCounts.nekros_prime_set).toBe(3);

    expect(deleteMarketAlertRule("rule-item")).toBe(true);
    const after = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      ownedCounts: Record<string, number>;
    };
    expect(after.ownedCounts.nekros_prime_set).toBeUndefined();
  });
});

describe("engine plumbing", () => {
  it("skips the whole tick while the scheduler is not ok", async () => {
    mocks.healthMock.mockReturnValue({ state: "backoff", recentFailures: 3 });
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "x" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).not.toHaveBeenCalled();
  });

  it("caps engine requests per tick", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    for (let i = 0; i < 10; i++) {
      saveOk(rivenRuleRaw({ id: `rule-${i}`, name: `Rule ${i}` }));
    }
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(4);
  });

  it("gives every rule a slot when there are more rules than per-tick requests", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    for (let i = 0; i < 14; i++) {
      saveOk(
        rivenRuleRaw({
          id: `rule-${i}`,
          name: `Rule ${i}`,
          riven: { weaponUrlName: `weapon_${i}` },
        }),
      );
    }
    initEngine();
    // setSystemTime avoids extra slots from the engine's own interval hiding starvation.
    const start = Date.now();
    for (let t = 0; t < 4; t++) {
      vi.setSystemTime(start + t * 60_000);
      await runMarketAlertTickForTest();
    }
    const queried = new Set(
      mocks.requestMock.mock.calls.map(
        (call) => /weapon_url_name=([a-z0-9_]+)/.exec(String(call[1]))?.[1] ?? "",
      ),
    );
    expect(queried.size).toBe(14);
  });

  it("drops a result whose rule was deleted mid-evaluation", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.requestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    saveOk(rivenRuleRaw());
    initEngine();

    const ticking = runMarketAlertTickForTest();
    expect(deleteMarketAlertRule("rule-riven")).toBe(true);
    release(auctionPayload([{ id: "late" }]));
    await ticking;

    expect(mocks.dispatchMock).not.toHaveBeenCalled();
    expect(getMarketAlertHits()).toHaveLength(0);
    const seenFile = path.join(tmpDir, "market-alert-seen.json");
    const bucket = fs.existsSync(seenFile)
      ? (JSON.parse(fs.readFileSync(seenFile, "utf8")) as { seen: Record<string, unknown> }).seen
      : {};
    expect(bucket["rule-riven"]).toBeUndefined();
  });

  it("pushes a change to the renderer when a hit is recorded", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "pushed" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(changedMock).toHaveBeenCalled();
  });

  it("quarantines an unreadable rules file instead of overwriting it", () => {
    const stateFile = path.join(tmpDir, "market-alert-rules.json");
    const original = JSON.stringify({ schema: 99, rules: [{ name: "precious" }] });
    fs.writeFileSync(stateFile, original, "utf8");

    expect(listMarketAlertRules().rules).toHaveLength(0);
    const status = getMarketAlertEngineStatus();
    expect(status.rulesRecoveredAt).toEqual(expect.any(String));

    const backup = fs.readdirSync(tmpDir).find((name) => name.includes(".corrupt-"));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(tmpDir, backup ?? ""), "utf8")).toBe(original);

    saveOk(rivenRuleRaw());
    expect(listMarketAlertRules().rules).toHaveLength(1);
  });

  it("revives the numeric endo of a stored hit and drops a malformed one", () => {
    const base = {
      ruleId: "r",
      ruleName: "Boar",
      at: "2026-09-12T10:00:00.000Z",
      kind: "riven",
      title: "Riven: Boar",
      detail: "stored before endo was recorded - 515 endo",
      url: "https://warframe.market/auction/x",
      platinum: 100,
    };
    fs.writeFileSync(
      path.join(tmpDir, "market-alert-hits.json"),
      JSON.stringify({
        schema: 1,
        hits: [
          { ...base, id: "with-endo", endo: 515, endoPerPlat: 5.2 },
          { ...base, id: "text-endo", endo: "515" },
          { ...base, id: "legacy" },
        ],
      }),
      "utf8",
    );

    const revived = getMarketAlertHits();
    expect(revived.map((hit) => hit.id)).toEqual(["with-endo", "text-endo", "legacy"]);
    expect(revived[0].endo).toBe(515);
    expect(revived[0].endoPerPlat).toBe(5.2);
    expect(revived[1]).not.toHaveProperty("endo");
    expect(revived[2]).not.toHaveProperty("endo");
  });

  it("keeps a rules file written before requireNegative was retired", () => {
    const stateFile = path.join(tmpDir, "market-alert-rules.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schema: 1,
        rules: [
          {
            id: "legacy",
            name: "Legacy Boar",
            kind: "riven",
            enabled: true,
            cooldownMinutes: 60,
            riven: {
              weaponUrlName: "boar",
              requirePositive: ["multishot"],
              requireNegative: ["recoil"],
              excludeAttributes: [],
              statBounds: [],
            },
          },
        ],
        bindings: { legacy: { native: true } },
        ownedCounts: {},
      }),
      "utf8",
    );

    const { rules } = listMarketAlertRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].riven?.allowedNegatives).toEqual(["recoil"]);
    expect(rules[0].riven?.hasNegative).toBe(true);
    expect(getMarketAlertEngineStatus().rulesRecoveredAt).toBeNull();

    saveOk(rivenRuleRaw({ id: "second", name: "Second" }));
    const rewritten = fs.readFileSync(stateFile, "utf8");
    expect(rewritten).not.toContain("requireNegative");
    expect(rewritten).toContain("legacy");
  });

  it("exports nothing for an explicitly empty selection", () => {
    saveOk(rivenRuleRaw({ id: "rule-a" }));
    saveOk(rivenRuleRaw({ id: "rule-b" }));
    const all = JSON.parse(exportMarketAlertRules()) as { rules: Array<{ id: string }> };
    expect(all.rules.map((rule) => rule.id)).toEqual(["rule-a", "rule-b"]);
    const one = JSON.parse(exportMarketAlertRules(["rule-b"])) as { rules: Array<{ id: string }> };
    expect(one.rules.map((rule) => rule.id)).toEqual(["rule-b"]);
    const none = JSON.parse(exportMarketAlertRules([])) as { rules: unknown[] };
    expect(none.rules).toHaveLength(0);
  });

  it("skips disabled and baro rules", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "x" }]));
    saveOk(rivenRuleRaw({ enabled: false }));
    saveOk({
      id: "rule-baro",
      name: "Baro watch",
      kind: "baro",
      baro: { itemUrlName: "primed_flow", maxDucats: 400 },
    });
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).not.toHaveBeenCalled();

    setMarketAlertRuleEnabled("rule-riven", true);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);
  });

  it("test-fires without touching dedup or cooldown", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "probe" }]));
    saveOk(rivenRuleRaw());
    initEngine();

    const result = await testFireMarketAlertRule("rule-riven");
    expect(result).toEqual({ ok: true, matches: 1, detail: expect.stringContaining("100p") });
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertHits()).toHaveLength(0);

    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(2);
    expect(getMarketAlertHits()).toHaveLength(1);
  });

  it("suppresses native delivery when the rule binding asks for it", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "quiet" }]));
    const saved = saveMarketAlertRule(rivenRuleRaw(), { native: false }, null);
    expect(saved.ok).toBe(true);
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it("reports status and clears hits", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "s1" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();

    const status = getMarketAlertEngineStatus();
    expect(status.running).toBe(true);
    expect(status.ruleCount).toBe(1);
    expect(status.enabledCount).toBe(1);
    expect(status.requestsLastHour).toBe(1);
    expect(status.scheduler.state).toBe("ok");
    expect(status.lastError).toBeNull();

    clearMarketAlertHits();
    expect(getMarketAlertHits()).toHaveLength(0);
  });

  it("deletes a rule together with its dedup state", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "gone" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(deleteMarketAlertRule("rule-riven")).toBe(true);
    expect(listMarketAlertRules().rules).toHaveLength(0);

    const seenFile = path.join(tmpDir, "market-alert-seen.json");
    const seen = JSON.parse(fs.readFileSync(seenFile, "utf8")) as { seen: Record<string, unknown> };
    expect(seen.seen["rule-riven"]).toBeUndefined();
  });

  it("imports rules disabled and exports criteria only", () => {
    saveOk(rivenRuleRaw());
    const exported = exportMarketAlertRules();
    expect(exported).not.toContain("bindings");
    expect(exported).not.toContain("ownedCounts");

    const result = importMarketAlertRules(exported);
    expect(result).toEqual({ ok: true, added: 1 });
    const { rules } = listMarketAlertRules();
    expect(rules).toHaveLength(2);
    const imported = rules.find((r) => r.id !== "rule-riven");
    expect(imported?.enabled).toBe(false);

    expect(importMarketAlertRules("{}").ok).toBe(false);
  });
});

describe("engine shutdown", () => {
  it("releases its timers, so the stopped guard is not what keeps it quiet", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    saveOk(rivenRuleRaw());
    initEngine();
    expect(vi.getTimerCount()).toBe(1); // the armed start delay
    await vi.advanceTimersByTimeAsync(31_000);
    expect(vi.getTimerCount()).toBe(1); // now the tick interval

    stopMarketAlerts();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the loop and refuses a tick that starts during a quit", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    saveOk(rivenRuleRaw());
    initEngine();
    await vi.advanceTimersByTimeAsync(31_000);
    const callsBefore = mocks.requestMock.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    stopMarketAlerts();
    expect(getMarketAlertEngineStatus().running).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock.mock.calls.length).toBe(callsBefore);
  });

  it("drops the result of a rule still in flight when the quit lands", async () => {
    let resolveSearch: (value: unknown) => void = () => {};
    mocks.requestMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    saveOk(rivenRuleRaw());
    initEngine();

    const tick = runMarketAlertTickForTest();
    stopMarketAlerts();
    resolveSearch(auctionPayload([{ id: "mid-quit" }]));
    await tick;

    expect(mocks.dispatchMock).not.toHaveBeenCalled();
    expect(getMarketAlertHits()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, "market-alert-hits.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "market-alert-seen.json"))).toBe(false);
  });

  it("drops a failing rule's error when the quit lands", async () => {
    let rejectSearch: (reason: unknown) => void = () => {};
    mocks.requestMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSearch = reject;
        }),
    );
    saveOk(rivenRuleRaw());
    initEngine();
    changedMock.mockClear();

    const tick = runMarketAlertTickForTest();
    stopMarketAlerts();
    rejectSearch(new Error("mid-quit failure"));
    await tick;

    expect(getMarketAlertEngineStatus().lastError).toBeNull();
    expect(changedMock).not.toHaveBeenCalled();
  });
});

describe("soak: hours of evaluation under 429s", () => {
  it("respects its own budget, backs off to the ceiling, and recovers", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockRejectedValue(new Error("Warframe.market rate limit hit (429)"));
    saveOk(rivenRuleRaw());
    initEngine();

    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    const phaseACalls = mocks.requestMock.mock.calls.length;
    expect(phaseACalls).toBeGreaterThanOrEqual(5);
    expect(phaseACalls).toBeLessThanOrEqual(9);
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
    expect(getMarketAlertEngineStatus().lastError).toContain("429");

    mocks.healthMock.mockReturnValue({ state: "backoff", recentFailures: 6 });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mocks.requestMock.mock.calls.length).toBe(phaseACalls);

    mocks.healthMock.mockReturnValue({ state: "ok", recentFailures: 0 });
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "recovered" }]));
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(mocks.requestMock.mock.calls.length).toBeGreaterThan(phaseACalls);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertHits()).toHaveLength(1);
    expect(getMarketAlertEngineStatus().lastError).toBeNull();
  });
});

describe("status error lifetime", () => {
  it("clears the error when the failing rule is deleted", async () => {
    mocks.requestMock.mockRejectedValue(new Error("wfm unreachable"));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(getMarketAlertEngineStatus().lastError).toContain("wfm unreachable");

    expect(deleteMarketAlertRule("rule-riven")).toBe(true);
    expect(getMarketAlertEngineStatus().lastError).toBeNull();
  });

  it("clears the error when the failing rule is switched off", async () => {
    mocks.requestMock.mockRejectedValue(new Error("wfm unreachable"));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();

    setMarketAlertRuleEnabled("rule-riven", false);
    expect(getMarketAlertEngineStatus().lastError).toBeNull();
    setMarketAlertRuleEnabled("rule-riven", true);
    expect(getMarketAlertEngineStatus().lastError).toBeNull();
  });

  it("keeps an error that belongs to a rule which is still there", async () => {
    mocks.requestMock.mockRejectedValue(new Error("wfm unreachable"));
    saveOk(rivenRuleRaw({ id: "rule-a" }));
    saveOk(rivenRuleRaw({ id: "rule-b" }));
    initEngine();
    await runMarketAlertTickForTest();

    expect(deleteMarketAlertRule("rule-a")).toBe(true);
    expect(getMarketAlertEngineStatus().lastError).toContain("wfm unreachable");
    expect(deleteMarketAlertRule("rule-b")).toBe(true);
    expect(getMarketAlertEngineStatus().lastError).toBeNull();
  });
});
