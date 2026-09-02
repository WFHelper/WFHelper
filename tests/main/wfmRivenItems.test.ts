import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

const mocks = vi.hoisted(() => ({
  requestMock: vi.fn<(method: string, path: string, opts?: unknown) => Promise<unknown>>(),
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
  requestV2: mocks.requestMock,
}));

import {
  getRivenWeaponSlugs,
  isRivenWeaponSlug,
  resetRivenItemsForTest,
} from "../../services/wfmRivenItems";

const CACHE_FILE = "wfm-riven-items.json";
const DAY_MS = 24 * 60 * 60 * 1000;

// The v2 /riven/weapons envelope: names nest per language under i18n.
function itemsPayload(names: Record<string, string>): unknown {
  return {
    apiVersion: "0.25.0",
    data: Object.entries(names).map(([slug, name]) => ({
      id: `id-${slug}`,
      slug,
      group: "primary",
      rivenType: "rifle",
      disposition: 1,
      i18n: { en: { name, icon: "items/images/en/x.png" } },
    })),
  };
}

function writeCache(fetchedAt: number, items: Record<string, string>): void {
  fs.writeFileSync(path.join(tmpDir, CACHE_FILE), JSON.stringify({ fetchedAt, items }), "utf8");
}

function readCache(): { fetchedAt: number; items: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, CACHE_FILE), "utf8"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfm-riven-items-"));
  mocks.requestMock.mockReset();
  resetRivenItemsForTest();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("wfmRivenItems", () => {
  it("fetches the list and persists it", async () => {
    mocks.requestMock.mockResolvedValue(itemsPayload({ rubico: "Rubico", ogris: "Ogris" }));

    const slugs = await getRivenWeaponSlugs();

    expect(slugs && [...slugs].sort()).toEqual(["ogris", "rubico"]);
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);
    expect(mocks.requestMock).toHaveBeenCalledWith("GET", "/riven/weapons", {
      priority: "background",
    });
    expect(readCache().items).toEqual({ rubico: "Rubico", ogris: "Ogris" });
  });

  it("answers membership without a second request once memoized", async () => {
    mocks.requestMock.mockResolvedValue(itemsPayload({ rubico: "Rubico" }));

    await expect(isRivenWeaponSlug("rubico")).resolves.toBe(true);
    await expect(isRivenWeaponSlug("archwing_agkuza")).resolves.toBe(false);
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);
  });

  it("reads a cache inside the TTL instead of fetching", async () => {
    writeCache(Date.now() - DAY_MS / 2, { rubico: "Rubico" });

    await expect(isRivenWeaponSlug("rubico")).resolves.toBe(true);
    expect(mocks.requestMock).not.toHaveBeenCalled();
  });

  it("refetches once the cache is older than the TTL", async () => {
    writeCache(Date.now() - DAY_MS - 60_000, { stale_weapon: "Stale" });
    mocks.requestMock.mockResolvedValue(itemsPayload({ rubico: "Rubico" }));

    const slugs = await getRivenWeaponSlugs();

    expect(slugs && [...slugs]).toEqual(["rubico"]);
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);
    expect(readCache().items).toEqual({ rubico: "Rubico" });
  });

  it("returns null for a malformed payload", async () => {
    mocks.requestMock.mockResolvedValue({ data: "not-a-list" });

    await expect(getRivenWeaponSlugs()).resolves.toBeNull();
    await expect(isRivenWeaponSlug("rubico")).resolves.toBeNull();
    expect(fs.existsSync(path.join(tmpDir, CACHE_FILE))).toBe(false);
  });

  it("returns null for an empty item list", async () => {
    mocks.requestMock.mockResolvedValue({ data: [] });

    await expect(getRivenWeaponSlugs()).resolves.toBeNull();
  });

  it("returns null when the request throws", async () => {
    mocks.requestMock.mockRejectedValue(new Error("WFM API error: 503"));

    await expect(getRivenWeaponSlugs()).resolves.toBeNull();
    await expect(isRivenWeaponSlug("rubico")).resolves.toBeNull();
  });

  it("ignores an unusable cache file and refetches", async () => {
    fs.writeFileSync(path.join(tmpDir, CACHE_FILE), "{ not json", "utf8");
    mocks.requestMock.mockResolvedValue(itemsPayload({ rubico: "Rubico" }));

    await expect(isRivenWeaponSlug("rubico")).resolves.toBe(true);
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent callers", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.requestMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = getRivenWeaponSlugs();
    const second = getRivenWeaponSlugs();
    release(itemsPayload({ rubico: "Rubico" }));

    expect(await first).toBe(await second);
    expect(mocks.requestMock).toHaveBeenCalledTimes(1);
  });
});
