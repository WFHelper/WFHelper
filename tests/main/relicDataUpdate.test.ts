import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readWfcdItems } from "../../services/bundledGameData";
import { isNewerVersion, validateRelicDataDoc } from "../../services/relicDataUpdate";

const state = vi.hoisted(() => ({ userData: "", bundledVersion: "1.1276.6" as string | null }));

vi.mock("electron", () => ({
  app: { getPath: () => state.userData, getVersion: () => "9.9.9" },
}));

vi.mock("../../services/bundledGameData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/bundledGameData")>();
  return { ...actual, readWfcdVersion: () => state.bundledVersion };
});

vi.mock("../../services/itemDatabase", () => ({
  localizedNameFields: () => ({}),
  lookupItem: () => null,
  lookupItemByNameOrSlug: () => null,
  toIconMirrorUrl: (url: string) => url,
}));

const INVENTED_RELIC = {
  uniqueName: "/Lotus/Types/Game/Projections/T4VoidProjectionZetaPrimeZ99Bronze",
  name: "Axi Z99 Intact",
  vaulted: false,
  dropCount: 3,
  rewards: [
    {
      chance: 2,
      rarity: "Rare",
      item: {
        uniqueName: "/Lotus/Types/Recipes/ZetaPrimeBlueprint",
        name: "Zeta Prime Blueprint",
        warframeMarket: { urlName: "zeta_prime_blueprint" },
      },
    },
  ],
};

type Row = Record<string, unknown>;

// What the backend route serves: the bundled relics trimmed to the fields the contract names.
function bundledRows(): Row[] {
  return readWfcdItems(["Relics"]).map((relic) => ({
    uniqueName: relic.uniqueName,
    name: relic.name,
    vaulted: Boolean(relic.vaulted),
    ...(relic.imageName ? { imageName: relic.imageName } : {}),
    dropCount: relic.drops?.length ?? 0,
    rewards: (relic.rewards ?? []).map((reward) => ({
      chance: reward.chance,
      rarity: reward.rarity,
      item: {
        uniqueName: reward.item?.uniqueName ?? "",
        name: reward.item?.name,
        ...(reward.item?.warframeMarket ? { warframeMarket: reward.item.warframeMarket } : {}),
      },
    })),
  }));
}

let rowsCache: Row[] | null = null;
function doc(version: string, extra: Row[] = [INVENTED_RELIC]) {
  rowsCache ??= bundledRows();
  return {
    ok: true,
    version,
    publishedAt: "2026-09-25T10:00:00.000Z",
    generatedAt: "2026-09-25T10:05:00.000Z",
    relics: [...rowsCache, ...extra],
  };
}

type FetchInit = Parameters<typeof fetch>[1];
type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: FetchInit) => Promise<Response>>>;

function stubFetch(respond: (init?: FetchInit) => Response | Promise<Response>): FetchMock {
  const fetchMock = vi.fn(async (_url: string, init?: FetchInit) => respond(init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function freshModules() {
  vi.resetModules();
  const update = await import("../../services/relicDataUpdate");
  const relics = await import("../../services/relicService");
  return { update, relics };
}

const cacheFile = () => path.join(state.userData, "wfcd-relics.json");

beforeEach(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-relic-data-"));
  state.bundledVersion = "1.1276.6";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fs.rmSync(state.userData, { recursive: true, force: true });
});

describe("relic data validation", () => {
  it("keeps every well-formed bundled relic and drops each malformed row shape", () => {
    const good = INVENTED_RELIC;
    const reward = good.rewards[0];
    const withReward = (patch: Row): Row => ({ ...good, rewards: [{ ...reward, ...patch }] });
    const withItem = (patch: Row): Row => withReward({ item: { ...reward.item, ...patch } });
    const malformed: Row[] = [
      { ...good, uniqueName: "/Lotus/Types/Recipes/NotARelic" },
      { ...good, uniqueName: good.uniqueName.replace(/Bronze$/, "Platinum") },
      { ...good, name: "Axi Z99" },
      { ...good, name: "Omni Z99 Intact" },
      { ...good, name: "Axi Z99 Pristine" },
      { ...good, vaulted: "yes" },
      { ...good, dropCount: -1 },
      { ...good, dropCount: 1.5 },
      { ...good, rewards: [] },
      { ...good, rewards: Array.from({ length: 13 }, () => reward) },
      { ...good, imageName: 7 },
      { ...good, imageName: "x".repeat(257) },
      withReward({ chance: 0 }),
      withReward({ chance: 101 }),
      withReward({ chance: "2" }),
      withReward({ rarity: "Legendary" }),
      withReward({ item: null }),
      withItem({ name: "" }),
      withItem({ name: "x".repeat(65) }),
      withItem({ uniqueName: 5 }),
      withItem({ ducats: "45" }),
      withItem({ warframeMarket: { urlName: 12 } }),
      "not a row",
    ].map((row, index) =>
      typeof row === "object" && row.name === good.name
        ? { ...row, name: `Axi Q${index} Intact` }
        : row,
    ) as Row[];

    const result = validateRelicDataDoc(doc("1.1277.0", [good, ...malformed]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // @wfcd/items 1.1276.6 ships 3,204 relics; 8 of them break the contract.
    expect(result.doc.relics).toHaveLength(3_197);
    expect(result.doc.relics.filter((row) => row.uniqueName === good.uniqueName)).toEqual([good]);
    expect(result.doc.publishedAt).toBe("2026-09-25T10:00:00.000Z");
  });

  it("rejects the whole document for a bad version or a row count outside 2,500..10,000", () => {
    const rows = doc("1.1277.0").relics;
    expect(validateRelicDataDoc({ ...doc("1.1277.0"), version: "1.1277" })).toEqual({
      ok: false,
      reason: "bad version",
    });
    expect(validateRelicDataDoc({ ...doc("v1.1277.0") }).ok).toBe(false);
    expect(validateRelicDataDoc({ ...doc("1.1277.0"), relics: rows.slice(0, 2_400) })).toEqual({
      ok: false,
      reason: expect.stringMatching(/valid relics$/),
    });
    const tooMany = [...rows, ...rows, ...rows, ...rows];
    expect(validateRelicDataDoc({ ...doc("1.1277.0"), relics: tooMany }).ok).toBe(false);
    const renamed = rows.map((row, index) => ({
      ...row,
      rewards: (row.rewards as Row[]).map((reward, slot) => ({
        ...reward,
        item: { ...(reward.item as Row), name: `Part ${index}-${slot}` },
      })),
    }));
    expect(validateRelicDataDoc({ ...doc("1.1277.0"), relics: renamed })).toEqual({
      ok: false,
      reason: "too many reward names",
    });
    expect(validateRelicDataDoc(null).ok).toBe(false);
  });

  it("compares versions numerically", () => {
    expect(isNewerVersion("1.1277.0", "1.1276.6")).toBe(true);
    expect(isNewerVersion("1.1276.10", "1.1276.9")).toBe(true);
    expect(isNewerVersion("1.1276.6", "1.1276.6")).toBe(false);
    expect(isNewerVersion("1.1275.99", "1.1276.0")).toBe(false);
  });
});

describe("relic data updates", () => {
  it("rebuilds the relic database and reward names from a newer download, then caches it", async () => {
    const { update, relics } = await freshModules();
    const body = JSON.stringify(doc("1.1277.0"));
    const fetchMock = stubFetch(
      () => new Response(body, { status: 200, headers: { ETag: '"r1"' } }),
    );
    const bundledGroups = Object.keys(relics.getRelicDatabase().groups).length;
    let rewardNames: string[] = [];
    const rebuilt = vi.fn(() => {
      rewardNames = relics.getRelicRewardItems().map((item) => item.name);
    });

    await update.startRelicDataUpdates(rebuilt);
    update.stopRelicDataUpdates();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.wfhelper.com/v1/wfcd-relics");
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(rewardNames).toContain("Zeta Prime Blueprint");
    const db = relics.getRelicDatabase();
    expect(Object.keys(db.groups)).toHaveLength(bundledGroups + 1);
    expect(db.groups["Axi Z99"]).toMatchObject({ tier: "Axi", code: "Z99", vaulted: false });
    expect(db.byUniqueName[INVENTED_RELIC.uniqueName]).toEqual({
      groupKey: "Axi Z99",
      quality: "intact",
    });
    // A relic with drops counted but no drop list still reads as unvaulted.
    expect(db.groups["Axi C12"]?.vaulted).toBe(false);
    expect(relics.getRelicDataInfo()).toEqual({
      version: "1.1277.0",
      source: "downloaded",
      publishedAt: "2026-09-25T10:00:00.000Z",
    });
    const cached = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    expect(cached.etag).toBe('"r1"');
    expect(cached.doc.version).toBe("1.1277.0");
  });

  it("ignores a download that is not newer than the bundled data", async () => {
    for (const version of ["1.1276.6", "1.1275.9", "2.0.0"]) {
      const { update, relics } = await freshModules();
      stubFetch(() => new Response(JSON.stringify(doc(version)), { status: 200 }));
      const rebuilt = vi.fn();

      await update.startRelicDataUpdates(rebuilt);
      update.stopRelicDataUpdates();

      expect(rebuilt).not.toHaveBeenCalled();
      expect(relics.getRelicDatabase().groups["Axi Z99"]).toBeUndefined();
      expect(relics.getRelicDataInfo()).toEqual({
        version: "1.1276.6",
        source: "bundled",
        publishedAt: null,
      });
      expect(fs.existsSync(cacheFile())).toBe(false);
    }
  });

  it("remembers only the tag of a download that is not newer, for a 304 on the next start", async () => {
    const first = await freshModules();
    stubFetch(
      () =>
        new Response(JSON.stringify(doc("1.1276.6")), { status: 200, headers: { etag: '"r0"' } }),
    );
    await first.update.startRelicDataUpdates(vi.fn());
    first.update.stopRelicDataUpdates();
    expect(JSON.parse(fs.readFileSync(cacheFile(), "utf8"))).toEqual({ etag: '"r0"', doc: null });

    const second = await freshModules();
    const fetchMock = stubFetch(() => new Response(null, { status: 304 }));
    const rebuilt = vi.fn();
    await second.update.startRelicDataUpdates(rebuilt);
    second.update.stopRelicDataUpdates();

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("If-None-Match")).toBe('"r0"');
    expect(rebuilt).not.toHaveBeenCalled();
    expect(second.relics.getRelicDataInfo().source).toBe("bundled");
  });

  it("stops reading a body past the 20 MiB cap instead of buffering it", async () => {
    const { update, relics } = await freshModules();
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    stubFetch(() => new Response(body, { status: 200 }));
    const rebuilt = vi.fn();
    await update.startRelicDataUpdates(rebuilt);
    update.stopRelicDataUpdates();

    expect(pulled).toBeLessThanOrEqual(22);
    expect(rebuilt).not.toHaveBeenCalled();
    expect(relics.getRelicDataInfo().source).toBe("bundled");
  });

  it("follows the backend back to an older doc, which is how a bad release is revoked", async () => {
    const { update, relics } = await freshModules();
    const docs = [doc("1.1277.1"), doc("1.1277.0", [])];
    stubFetch(
      () => new Response(JSON.stringify(docs.shift()), { status: 200, headers: { etag: '"e"' } }),
    );
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const rebuilt = vi.fn();
    await update.startRelicDataUpdates(rebuilt);
    expect(relics.getRelicDataInfo().version).toBe("1.1277.1");

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    await update.startRelicDataUpdates(rebuilt);
    update.stopRelicDataUpdates();

    expect(rebuilt).toHaveBeenCalledTimes(2);
    expect(relics.getRelicDataInfo().version).toBe("1.1277.0");
    expect(relics.getRelicDatabase().groups["Axi Z99"]).toBeUndefined();
  });

  it("goes back to the bundled relics and forgets the copy once the backend serves none", async () => {
    const { update, relics } = await freshModules();
    const answers = [
      new Response(JSON.stringify(doc("1.1277.0")), { status: 200, headers: { etag: '"a"' } }),
      new Response('{"ok":false,"error":"wfcd_relics_not_ready"}', { status: 404 }),
    ];
    stubFetch(() => answers.shift() ?? new Response(null, { status: 500 }));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const rebuilt = vi.fn();
    await update.startRelicDataUpdates(rebuilt);
    expect(relics.getRelicDataInfo().source).toBe("downloaded");

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    await update.startRelicDataUpdates(rebuilt);
    update.stopRelicDataUpdates();

    expect(rebuilt).toHaveBeenCalledTimes(2);
    expect(relics.getRelicDataInfo().source).toBe("bundled");
    expect(relics.getRelicDatabase().groups["Axi Z99"]).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(cacheFile(), "utf8"))).toEqual({ etag: null, doc: null });
  });

  it("applies the cached copy after a restart until a newer bundle replaces it", async () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({ etag: '"r1"', doc: doc("1.1277.0") }));

    const first = await freshModules();
    const fetchMock = stubFetch(() => new Response(null, { status: 304 }));
    const rebuilt = vi.fn();
    await first.update.startRelicDataUpdates(rebuilt);
    first.update.stopRelicDataUpdates();

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("If-None-Match")).toBe('"r1"');
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(first.relics.getRelicDatabase().groups["Axi Z99"]).toBeDefined();
    expect(first.relics.getRelicDataInfo().source).toBe("downloaded");

    state.bundledVersion = "1.1278.0";
    const second = await freshModules();
    const skipped = vi.fn();
    await second.update.startRelicDataUpdates(skipped);
    second.update.stopRelicDataUpdates();

    expect(skipped).not.toHaveBeenCalled();
    expect(second.relics.getRelicDatabase().groups["Axi Z99"]).toBeUndefined();
    expect(second.relics.getRelicDataInfo()).toMatchObject({
      version: "1.1278.0",
      source: "bundled",
    });
    // The rows that lost to the bundle are dropped; the tag stays for a 304.
    expect(JSON.parse(fs.readFileSync(cacheFile(), "utf8"))).toEqual({ etag: '"r1"', doc: null });
  });

  it.each([
    ["404", () => new Response('{"ok":false,"error":"wfcd_relics_not_ready"}', { status: 404 })],
    ["a network failure", () => Promise.reject(new Error("offline"))],
    ["an invalid document", () => new Response(JSON.stringify(doc("latest")), { status: 200 })],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
  ])(
    "keeps the bundled data after %s and waits six hours to ask again",
    async (_label, respond) => {
      fs.writeFileSync(cacheFile(), "{ not json");
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { update, relics } = await freshModules();
      const fetchMock = stubFetch(respond);
      const rebuilt = vi.fn();

      await update.startRelicDataUpdates(rebuilt);
      vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      update.stopRelicDataUpdates();

      expect(rebuilt).not.toHaveBeenCalled();
      expect(relics.getRelicDataInfo().source).toBe("bundled");
      expect(relics.getRelicDatabase().groups["Axi C12"]).toBeDefined();
    },
  );
});
