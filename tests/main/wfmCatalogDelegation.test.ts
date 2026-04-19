import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("wfmCatalog item lookups", () => {
  it("loads and exposes name/url/renderer mapping", async () => {
    const wfmClient = await import("../../services/wfmClient");
    vi.spyOn(wfmClient, "requestV2").mockResolvedValue({
      data: {
        items: [
          {
            id: "wf-item-id",
            slug: "ash_prime_set",
            i18n: {
              en: {
                itemName: "Ash Prime Set",
                thumb: "thumb/ash.png",
                icon: "icon/ash.png",
              },
            },
          },
        ],
      },
    });

    const wfmCatalog = await import("../../services/wfmCatalog");

    await expect(wfmCatalog.ensureLoaded()).resolves.toBe(1);
    expect(wfmCatalog.isLoaded()).toBe(true);

    expect(wfmCatalog.lookupByName("Ash Prime Set")).toMatchObject({
      url_name: "ash_prime_set",
      item_name: "Ash Prime Set",
      thumb: "https://warframe.market/static/assets/thumb/ash.png",
      icon: "https://warframe.market/static/assets/icon/ash.png",
    });

    expect(wfmCatalog.lookupByName("Ash Prime")).toMatchObject({
      url_name: "ash_prime_set",
    });

    expect(wfmCatalog.getMarketUrl("Ash Prime Set")).toBe(
      "https://warframe.market/items/ash_prime_set",
    );

    expect(wfmCatalog.getRendererLookup()["ash prime set"]).toMatchObject({
      url_name: "ash_prime_set",
      item_name: "Ash Prime Set",
    });
  });
});
