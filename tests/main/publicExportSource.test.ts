import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-public-export-"));
const cachePath = path.join(tempDir, "public-export-cache.json");

vi.mock("electron", () => ({
  app: { getPath: () => tempDir },
}));

const INDEX_URL = "https://content.warframe.com/PublicExport/index_en.txt.lzma";
const MANIFEST_BASE = "https://content.warframe.com/PublicExport/Manifest/";

const SUIT = "/Lotus/Powersuits/Test/TestSuit";
const SUIT_TEXTURE = "/Lotus/Interface/Icons/Test/TestSuit.png!00_abc";
const NEW_MOD = "/Lotus/Upgrades/Mods/Pistol/Event/Nightwave/TestOnlyAugmentMod";
const NEW_MOD_TEXTURE = "/Lotus/Interface/Cards/Images/Nightwave/TestOnlyAugmentMod.jpg!00_def";
// Really in the bundled package, so the overlay must not carry a copy of it.
const BUNDLED_MOD = "/Lotus/Upgrades/Mods/Warframe/AvatarSlideBoostMod";
const NEW_RELIC = "/Lotus/Types/Game/Projections/TestVoidProjectionA";
const NEW_ARCANE = "/Lotus/Upgrades/CosmeticEnhancers/Test/TestArcane";

const indexText = [
  "ExportWarframes_en.json!00_wf",
  "ExportWeapons_en.json!00_wp",
  "ExportSentinels_en.json!00_se",
  "ExportUpgrades_en.json!00_up",
  "ExportRelicArcane_en.json!00_ra",
  "ExportManifest.json!00_img",
].join("\n");

let compressedIndex: Buffer;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

function indexResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      compressedIndex.buffer.slice(
        compressedIndex.byteOffset,
        compressedIndex.byteOffset + compressedIndex.byteLength,
      ),
  } as unknown as Response;
}

const fetchMock = vi.fn(async (url: string) => {
  if (url === INDEX_URL) return indexResponse();
  if (url === `${MANIFEST_BASE}ExportWarframes_en.json!00_wf`)
    return jsonResponse({
      ExportWarframes: [{ uniqueName: SUIT, name: "Test Suit", masteryReq: 0 }],
    });
  if (url === `${MANIFEST_BASE}ExportWeapons_en.json!00_wp`)
    return jsonResponse({ ExportWeapons: [] });
  if (url === `${MANIFEST_BASE}ExportSentinels_en.json!00_se`)
    return jsonResponse({ ExportSentinels: [] });
  if (url === `${MANIFEST_BASE}ExportUpgrades_en.json!00_up`)
    return jsonResponse({
      ExportUpgrades: [
        {
          uniqueName: NEW_MOD,
          name: "Test Only Augment",
          rarity: "RARE",
          levelStats: [{ stats: ["a"] }, { stats: ["b"] }],
        },
        { uniqueName: BUNDLED_MOD, name: "Bundled Already" },
      ],
    });
  if (url === `${MANIFEST_BASE}ExportRelicArcane_en.json!00_ra`)
    return jsonResponse({
      ExportRelicArcane: [
        { uniqueName: NEW_RELIC, name: "Test A1 Relic", relicRewards: [{ rewardName: "x" }] },
        { uniqueName: NEW_ARCANE, name: "Test Arcane" },
      ],
    });
  if (url === `${MANIFEST_BASE}ExportManifest.json!00_img`)
    return jsonResponse({
      Manifest: [
        { uniqueName: SUIT, textureLocation: SUIT_TEXTURE },
        { uniqueName: NEW_MOD, textureLocation: NEW_MOD_TEXTURE },
        { uniqueName: BUNDLED_MOD, textureLocation: "/Lotus/Interface/Bundled.png!00_zzz" },
      ],
    });
  throw new Error(`unexpected fetch ${url}`);
});

async function importService() {
  vi.resetModules();
  return import("../../services/publicExportSource");
}

function callsTo(url: string): number {
  return fetchMock.mock.calls.filter(([u]) => u === url).length;
}

function compressIndex(text: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lzma = require("lzma") as {
    compress: (data: string, mode: number, cb: (result: number[], err: unknown) => void) => void;
  };
  return new Promise((resolve, reject) =>
    lzma.compress(text, 1, (result, err) =>
      err
        ? reject(err instanceof Error ? err : new Error(String(err)))
        : resolve(Buffer.from(result)),
    ),
  );
}

describe("publicExportSource", () => {
  beforeEach(async () => {
    fs.rmSync(cachePath, { force: true });
    compressedIndex = await compressIndex(indexText);
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills missing item icons from DE's image manifest", async () => {
    const service = await importService();
    const { changed } = await service.refreshOverlayFromDE();
    expect(changed).toBe(true);

    const overlay = service.getOverlay();
    expect(overlay?.exports.ExportWarframes?.[SUIT]?.icon).toBe(
      "/Lotus/Interface/Icons/Test/TestSuit.png",
    );
    // full texture location (with content hash) stays available for mirror fallbacks
    expect(overlay?.images?.[SUIT]).toBe(SUIT_TEXTURE);
  });

  it("skips unchanged manifests on the next refresh and keeps enriched icons", async () => {
    const first = await importService();
    await first.refreshOverlayFromDE();

    const second = await importService();
    const { changed } = await second.refreshOverlayFromDE();
    expect(changed).toBe(false);

    // index re-checked, but no manifest was re-downloaded
    expect(callsTo(INDEX_URL)).toBe(2);
    expect(callsTo(`${MANIFEST_BASE}ExportWarframes_en.json!00_wf`)).toBe(1);
    expect(callsTo(`${MANIFEST_BASE}ExportManifest.json!00_img`)).toBe(1);

    expect(second.getOverlay()?.exports.ExportWarframes?.[SUIT]?.icon).toBe(
      "/Lotus/Interface/Icons/Test/TestSuit.png",
    );
  });

  it("carries a mod the bundled package never shipped", async () => {
    const service = await importService();
    await service.refreshOverlayFromDE();

    const mods = service.getOverlay()?.exports.ExportUpgrades;
    expect(mods?.[NEW_MOD]?.name).toBe("Test Only Augment");
    expect(mods?.[NEW_MOD]?.icon).toBe(
      "/Lotus/Interface/Cards/Images/Nightwave/TestOnlyAugmentMod.jpg",
    );
    // per-rank stat tables are the bulk of DE's export and nothing reads them
    expect(mods?.[NEW_MOD]?.levelStats).toBeUndefined();
  });

  it("leaves out what the bundled package already carries", async () => {
    const service = await importService();
    await service.refreshOverlayFromDE();

    expect(service.getOverlay()?.exports.ExportUpgrades?.[BUNDLED_MOD]).toBeUndefined();
    expect(service.getOverlay()?.images?.[BUNDLED_MOD]).toBeUndefined();
  });

  it("splits DE's shared relic and arcane manifest", async () => {
    const service = await importService();
    await service.refreshOverlayFromDE();

    const exports = service.getOverlay()?.exports;
    expect(exports?.ExportRelics?.[NEW_RELIC]?.name).toBe("Test A1 Relic");
    expect(exports?.ExportArcanes?.[NEW_ARCANE]?.name).toBe("Test Arcane");
    expect(exports?.ExportRelics?.[NEW_ARCANE]).toBeUndefined();
    expect(exports?.ExportArcanes?.[NEW_RELIC]).toBeUndefined();
  });

  it("refetches when the cache predates the wider manifest coverage, keeping its exports", async () => {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        index: { ExportWarframes: "ExportWarframes_en.json!00_wf" },
        exports: { ExportWarframes: { [SUIT]: { uniqueName: SUIT, name: "Stale Suit" } } },
      }),
      "utf8",
    );

    const service = await importService();
    // an offline start still sees the last-good items, stale names and all
    expect(service.loadOverlayFromDisk()?.exports.ExportWarframes?.[SUIT]?.name).toBe("Stale Suit");
    await service.refreshOverlayFromDE();

    expect(callsTo(`${MANIFEST_BASE}ExportWarframes_en.json!00_wf`)).toBe(1);
    expect(service.getOverlay()?.exports.ExportWarframes?.[SUIT]?.name).toBe("Test Suit");
  });

  it("keeps the cached overlay when the index lists none of DE's manifests", async () => {
    const first = await importService();
    await first.refreshOverlayFromDE();
    const cached = fs.readFileSync(cachePath, "utf8");

    compressedIndex = await compressIndex("SomeRenamedExport_en.json!00_zz");
    const second = await importService();
    const { changed } = await second.refreshOverlayFromDE();

    expect(changed).toBe(false);
    expect(second.getOverlay()?.exports.ExportWarframes?.[SUIT]?.name).toBe("Test Suit");
    expect(fs.readFileSync(cachePath, "utf8")).toBe(cached);
  });

  it("leaves the cache file untouched when nothing changed", async () => {
    const first = await importService();
    await first.refreshOverlayFromDE();
    const cached = fs.readFileSync(cachePath, "utf8");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // A rewrite would carry a new updatedAt stamp.
      vi.setSystemTime(Date.now() + 60_000);
      const second = await importService();
      const { changed } = await second.refreshOverlayFromDE();

      expect(changed).toBe(false);
      expect(fs.readFileSync(cachePath, "utf8")).toBe(cached);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rewrites a cache file it cannot read", async () => {
    fs.writeFileSync(cachePath, "{ not json", "utf8");

    const service = await importService();
    await service.refreshOverlayFromDE();

    const written = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(written.exports.ExportWarframes[SUIT].name).toBe("Test Suit");
  });

  it("rewrites the cache when DE stops listing a manifest", async () => {
    const first = await importService();
    await first.refreshOverlayFromDE();

    compressedIndex = await compressIndex(
      indexText
        .split("\n")
        .filter((line) => !line.startsWith("ExportSentinels_en.json"))
        .join("\n"),
    );
    const second = await importService();
    const { changed } = await second.refreshOverlayFromDE();

    expect(changed).toBe(false);
    const written = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(Object.keys(written.index)).not.toContain("ExportSentinels_en.json");
    expect(written.exports.ExportWarframes[SUIT].name).toBe("Test Suit");
  });

  it("gives up on a stalled download and can refresh again afterwards", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        ),
      );

      const service = await importService();
      const stalled = service.refreshOverlayFromDE();
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(stalled).resolves.toEqual({ changed: false });
      expect(fs.existsSync(cachePath)).toBe(false);

      vi.useRealTimers();
      vi.stubGlobal("fetch", fetchMock);
      const { changed } = await service.refreshOverlayFromDE();
      expect(changed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
