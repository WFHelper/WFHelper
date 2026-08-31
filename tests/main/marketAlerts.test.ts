import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

const mocks = vi.hoisted(() => ({
  requestMock: vi.fn<(method: string, path: string, opts?: unknown) => Promise<unknown>>(),
  healthMock: vi.fn<() => { state: "ok" | "backoff" | "degraded"; recentFailures: number }>(),
  dispatchMock: vi.fn(
    (_payload: { source: string; title: string; body: string }, deliverNative?: () => void) => {
      deliverNative?.();
    },
  ),
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
}));

vi.mock("../../services/wfmScheduler", () => ({
  getWfmSchedulerHealth: mocks.healthMock,
}));

vi.mock("../../services/notificationChannels", () => ({
  dispatch: mocks.dispatchMock,
}));

import {
  clearMarketAlertHits,
  deleteMarketAlertRule,
  exportMarketAlertRules,
  getMarketAlertEngineStatus,
  getMarketAlertHits,
  importMarketAlertRules,
  initMarketAlerts,
  listMarketAlertRules,
  resetMarketAlertsForTest,
  runMarketAlertTickForTest,
  saveMarketAlertRule,
  setMarketAlertRuleEnabled,
  testFireMarketAlertRule,
} from "../../services/marketAlerts";

const deliverMock = vi.fn();
let ownName: string | null = null;

function initEngine(): void {
  initMarketAlerts({
    deliverNative: deliverMock,
    getOwnName: () => ownName,
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
}

function ordersPayload(specs: OrderSpec[]): unknown {
  return {
    payload: {
      orders: specs.map((spec, index) => ({
        id: spec.id ?? `order-${index}`,
        order_type: spec.type ?? "sell",
        platinum: spec.platinum ?? 40,
        quantity: spec.quantity ?? 1,
        visible: spec.visible ?? true,
        platform: spec.platform ?? "pc",
        user: { ingame_name: spec.owner ?? "OtherUser", status: spec.status ?? "ingame" },
      })),
    },
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
  mocks.healthMock.mockReset();
  mocks.healthMock.mockReturnValue({ state: "ok", recentFailures: 0 });
  mocks.dispatchMock.mockClear();
  deliverMock.mockClear();
  ownName = null;
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
      auctionPayload([{ id: "abc123", buyout: 100, mastery: 13, modRank: 0, rerolls: 0 }]),
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
    expect(hits[0].endoPerPlat).toBeCloseTo(5.2, 1);
  });

  it("matches attributes by exact url_name, never substring", async () => {
    // The slide-attack slug contains "critical_chance"; substring matching is
    // the documented failure mode and must not fire here.
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

  it("pushes server-side filters into the search query", async () => {
    mocks.requestMock.mockResolvedValue(auctionPayload([]));
    saveOk(
      rivenRuleRaw({
        riven: {
          requirePositive: ["critical_chance", "critical_damage"],
          requireNegative: ["zoom"],
          polarity: "madurai",
          minMasteryRank: 9,
          maxMasteryRank: 15,
          minRerolls: 1,
          maxRerolls: 50,
          minSimilarityPct: 50,
        },
      }),
    );
    initEngine();
    await runMarketAlertTickForTest();
    const requestPath = mocks.requestMock.mock.calls[0][1];
    expect(requestPath).toContain("weapon_url_name=rubico");
    expect(requestPath).toContain("positive_stats=critical_chance");
    expect(requestPath).toContain("negative_stats=zoom");
    expect(requestPath).toContain("polarity=madurai");
    expect(requestPath).toContain("mastery_rank_min=9");
    expect(requestPath).toContain("mastery_rank_max=15");
    expect(requestPath).toContain("re_rolls_min=1");
    expect(requestPath).toContain("similarity=50");
    // Background priority keeps the sweep behind anything a user is waiting on.
    expect(mocks.requestMock.mock.calls[0][2]).toEqual({ priority: "background" });
  });

  it("applies similarity as the share of required stats present", async () => {
    mocks.requestMock.mockResolvedValue(
      auctionPayload([
        { id: "half", attributes: [{ url_name: "critical_chance", value: 100, positive: true }] },
      ]),
    );
    // Two required stats, only one present: 50% passes a 50 gate, not 60.
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
        // 120% crit passes the bound; endo/plat for MR14 r8 5 rolls at 100p:
        // (600 + 5760 + 1000 - 7) / 100 = 73.5.
        { id: "good", buyout: 100 },
        // Below the crit bound.
        {
          id: "weak",
          attributes: [{ url_name: "critical_chance", value: 80, positive: true }],
        },
        // Same roll, price too high for the endo gate.
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

    // Past the eval spacing but inside the 60 minute cooldown: no request at all.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);

    // Past the cooldown: the listing is fetched again but already seen.
    await vi.advanceTimersByTimeAsync(56 * 60_000);
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertHits()).toHaveLength(1);
  });

  it("re-evaluates a rule edited during its cooldown", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "first" }]));
    saveOk(rivenRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);

    // Deep inside the 60 minute cooldown, but the criteria just changed.
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

    // Same userData dir, fresh process state: cooldowns are gone, the seen
    // file is not.
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
    mocks.requestMock.mockResolvedValue(
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
    expect(mocks.requestMock.mock.calls[0][1]).toBe("/items/nekros_prime_set/orders");
  });

  it("excludes the user's own orders", async () => {
    ownName = "TraderMe";
    mocks.requestMock.mockResolvedValue(
      ordersPayload([{ id: "mine", owner: "traderme", platinum: 10 }]),
    );
    saveOk(itemRuleRaw());
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
  });

  it("applies owned-count gates from the renderer-supplied count", async () => {
    mocks.requestMock.mockResolvedValue(ordersPayload([{ id: "o1", platinum: 30 }]));
    saveOk(itemRuleRaw({ item: { ownedBelow: 2 } }), 3);
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).not.toHaveBeenCalled();

    saveOk(itemRuleRaw({ item: { ownedBelow: 5 } }), 3);
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("fails open when no owned count was ever pushed", async () => {
    mocks.requestMock.mockResolvedValue(ordersPayload([{ id: "o1", platinum: 30 }]));
    saveOk(itemRuleRaw({ item: { ownedBelow: 2 } }), null);
    initEngine();
    await runMarketAlertTickForTest();
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
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

    // The real tick still fires: the test run marked nothing as seen.
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

describe("soak: hours of evaluation under 429s", () => {
  it("respects its own budget, backs off to the ceiling, and recovers", async () => {
    vi.useFakeTimers();
    mocks.requestMock.mockRejectedValue(new Error("Warframe.market rate limit hit (429)"));
    saveOk(rivenRuleRaw());
    initEngine();

    // Phase A: four hours of continuous 429s. The per-rule backoff doubles
    // 5 -> 10 -> 20 -> 40 -> 60 and then holds the 60 minute ceiling, so the
    // engine sends a handful of requests, not hundreds of ticks' worth.
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    const phaseACalls = mocks.requestMock.mock.calls.length;
    expect(phaseACalls).toBeGreaterThanOrEqual(5);
    expect(phaseACalls).toBeLessThanOrEqual(9);
    expect(mocks.dispatchMock).not.toHaveBeenCalled();
    expect(getMarketAlertEngineStatus().lastError).toContain("429");

    // Phase B: the shared scheduler reports a gate; the engine goes silent.
    mocks.healthMock.mockReturnValue({ state: "backoff", recentFailures: 6 });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mocks.requestMock.mock.calls.length).toBe(phaseACalls);

    // Phase C: WFM recovers; the next due evaluation fires the rule.
    mocks.healthMock.mockReturnValue({ state: "ok", recentFailures: 0 });
    mocks.requestMock.mockResolvedValue(auctionPayload([{ id: "recovered" }]));
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(mocks.requestMock.mock.calls.length).toBeGreaterThan(phaseACalls);
    expect(mocks.dispatchMock).toHaveBeenCalledTimes(1);
    expect(getMarketAlertHits()).toHaveLength(1);
    expect(getMarketAlertEngineStatus().lastError).toBeNull();
  });
});
