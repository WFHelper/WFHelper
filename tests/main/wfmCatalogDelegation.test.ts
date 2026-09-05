import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Catalog loads try the backend worker first - keep unit tests off the network. */
function stubBackendCatalogOffline(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
}

describe("wfmCatalog item lookups", () => {
  it("prefers the backend worker catalog and skips direct WFM", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          updatedAt: 123,
          items: [
            {
              id: "wf-item-id",
              slug: "ash_prime_set",
              name: "Ash Prime Set",
              thumb: "thumb/ash.png",
              icon: null,
              maxRank: null,
              gameRef: null,
            },
          ],
        }),
      }),
    );
    const wfmClient = await import("../../services/wfmClient");
    const request = vi.spyOn(wfmClient, "requestV2");
    const wfmCatalog = await import("../../services/wfmCatalog");

    await expect(wfmCatalog.ensureLoaded()).resolves.toBe(1);
    expect(request).not.toHaveBeenCalled();
    expect(wfmCatalog.lookupByName("Ash Prime Set")).toMatchObject({
      url_name: "ash_prime_set",
      thumb: "https://warframe.market/static/assets/thumb/ash.png",
    });
  });

  it("indexes a disambiguated listing under the bare game name", async () => {
    const item = (id: string, slug: string, name: string) => ({
      id,
      slug,
      name,
      thumb: null,
      icon: null,
      maxRank: null,
      gameRef: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          updatedAt: 123,
          items: [
            item("a", "mutalist_alad_v_assassinate_key", "Mutalist Alad V Assassinate (Key)"),
            item("b", "equilibrium_(steam_pinnacle_pack)", "Equilibrium (Steam Pinnacle Pack)"),
            item("c", "equilibrium", "Equilibrium"),
          ],
        }),
      }),
    );
    const wfmCatalog = await import("../../services/wfmCatalog");

    await expect(wfmCatalog.ensureLoaded()).resolves.toBe(3);
    expect(wfmCatalog.lookupByName("Mutalist Alad V Assassinate")).toMatchObject({
      url_name: "mutalist_alad_v_assassinate_key",
    });
    // The pack reprint must not shadow the mod that owns the bare name.
    expect(wfmCatalog.lookupByName("Equilibrium")).toMatchObject({ url_name: "equilibrium" });
  });

  it("falls back to direct WFM when the backend catalog is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, items: [] }) }),
    );
    const wfmClient = await import("../../services/wfmClient");
    const request = vi.spyOn(wfmClient, "requestV2").mockResolvedValue({
      data: { items: [{ id: "wf-item-id", slug: "ash_prime_set" }] },
    });
    const wfmCatalog = await import("../../services/wfmCatalog");

    await expect(wfmCatalog.ensureLoaded()).resolves.toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    // The largest sweep never takes a slot from something a user is waiting on.
    expect(request).toHaveBeenCalledWith("GET", "/items", { priority: "background" });
  });

  it("loads and exposes name/url/renderer mapping", async () => {
    stubBackendCatalogOffline();
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

    expect(wfmCatalog.getRendererLookup()["ash prime set"]).toMatchObject({
      url_name: "ash_prime_set",
      item_name: "Ash Prime Set",
    });
  });

  it("does not latch an empty catalog and recovers on a later retry", async () => {
    vi.useFakeTimers();
    stubBackendCatalogOffline();
    const wfmClient = await import("../../services/wfmClient");
    const request = vi.spyOn(wfmClient, "requestV2").mockRejectedValue(new Error("timeout"));
    const wfmCatalog = await import("../../services/wfmCatalog");

    await expect(wfmCatalog.ensureLoaded()).rejects.toThrow("no items");
    expect(wfmCatalog.isLoaded()).toBe(false);
    // One send per load: replaying a transport failure is the scheduler's job.
    expect(request).toHaveBeenCalledTimes(1);

    // Within the failure cooldown: rejects fast without another network call.
    await expect(wfmCatalog.ensureLoaded()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(16_000);
    request.mockResolvedValue({
      data: { items: [{ id: "wf-item-id", slug: "ash_prime_set" }] },
    });
    await expect(wfmCatalog.ensureLoaded()).resolves.toBe(1);
    expect(wfmCatalog.isLoaded()).toBe(true);
  });

  it("caches one valid set response under every member slug", async () => {
    const wfmClient = await import("../../services/wfmClient");
    const request = vi.spyOn(wfmClient, "requestV2").mockResolvedValue({
      data: {
        items: [
          { slug: "akbronco_prime_set", setRoot: true },
          { slug: "akbronco_prime_blueprint", setRoot: false, quantityInSet: 1 },
          { slug: "bronco_prime_set", setRoot: false, quantityInSet: 2 },
        ],
      },
    });
    const wfmCatalog = await import("../../services/wfmCatalog");

    const first = await wfmCatalog.resolveSetMembership("akbronco_prime_blueprint");
    const second = await wfmCatalog.resolveSetMembership("bronco_prime_set");

    expect(first).toEqual({
      kind: "set",
      setSlug: "akbronco_prime_set",
      parts: [
        { slug: "akbronco_prime_blueprint", quantityInSet: 1 },
        { slug: "bronco_prime_set", quantityInSet: 2 },
      ],
    });
    expect(second).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not cache malformed set quantities", async () => {
    const wfmClient = await import("../../services/wfmClient");
    const request = vi.spyOn(wfmClient, "requestV2").mockResolvedValue({
      data: {
        items: [
          { slug: "broken_set", setRoot: true },
          { slug: "broken_blueprint", setRoot: false, quantityInSet: 1 },
          { slug: "broken_part", setRoot: false },
        ],
      },
    });
    const wfmCatalog = await import("../../services/wfmCatalog");

    await expect(wfmCatalog.resolveSetMembership("broken_part")).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(wfmCatalog.resolveSetMembership("broken_part")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("caches a 404 as a non-set item", async () => {
    const wfmClient = await import("../../services/wfmClient");
    // Same module graph as the catalog under test, or the instanceof gate misses.
    const { WfmApiError } = await import("../../services/wfmTypes");
    const request = vi
      .spyOn(wfmClient, "requestV2")
      .mockRejectedValue(new WfmApiError("not found", "WFM_API_ERROR", 404));
    const wfmCatalog = await import("../../services/wfmCatalog");

    await expect(wfmCatalog.resolveSetMembership("forma_blueprint")).resolves.toEqual({
      kind: "not-set",
    });
    await expect(wfmCatalog.resolveSetMembership("forma_blueprint")).resolves.toEqual({
      kind: "not-set",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
