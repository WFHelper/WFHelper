import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { DEFAULT_STAT_RESOURCE_IDS, STAT_RESOURCES } from "../../../config/shared/statsTypes.js";

const STORAGE_KEY = "wf_stats_chart_resources";

function stubStorage(initial?: string): Map<string, string> {
  const mem = new Map<string, string>();
  if (initial !== undefined) mem.set(STORAGE_KEY, initial);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  });
  return mem;
}

async function importStore() {
  vi.resetModules();
  return import("../../../src/stores/statsDisplay.js");
}

afterEach(() => vi.unstubAllGlobals());

describe("stats chart resource prefs", () => {
  it("defaults to the pre-map six plus Kuva", async () => {
    stubStorage();
    const store = await importStore();
    expect(get(store.chartResources)).toEqual([...DEFAULT_STAT_RESOURCE_IDS]);
  });

  it("drops stored ids this build does not record", async () => {
    stubStorage(JSON.stringify(["plat", "unobtanium", "kuva", "ayaDelta"]));
    const store = await importStore();
    expect(get(store.chartResources)).toEqual(["plat", "kuva"]);
  });

  it("falls back to the defaults on corrupt or non-array prefs", async () => {
    stubStorage("{not json");
    const corrupt = await importStore();
    expect(get(corrupt.chartResources)).toEqual([...DEFAULT_STAT_RESOURCE_IDS]);

    stubStorage(JSON.stringify({ plat: true }));
    const wrongShape = await importStore();
    expect(get(wrongShape.chartResources)).toEqual([...DEFAULT_STAT_RESOURCE_IDS]);
  });

  it("keeps an empty selection instead of resurrecting the defaults", async () => {
    const mem = stubStorage(JSON.stringify([]));
    const store = await importStore();
    expect(get(store.chartResources)).toEqual([]);

    store.toggleChartResource("kuva");
    expect(get(store.chartResources)).toEqual(["kuva"]);
    expect(JSON.parse(mem.get(STORAGE_KEY) as string)).toEqual(["kuva"]);

    store.toggleChartResource("kuva");
    expect(get(store.chartResources)).toEqual([]);
  });

  it("renders in catalog order however the prefs were written", async () => {
    stubStorage(JSON.stringify(["kuva", "plat", "credits"]));
    const store = await importStore();
    const order = STAT_RESOURCES.map((r) => r.id);
    const selected = get(store.chartResources);
    expect(selected).toEqual([...selected].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(selected).toEqual(["plat", "credits", "kuva"]);
  });

  it("resets back to the defaults", async () => {
    stubStorage(JSON.stringify(["kuva"]));
    const store = await importStore();
    store.resetChartResources();
    expect(get(store.chartResources)).toEqual([...DEFAULT_STAT_RESOURCE_IDS]);
  });

  // The label keys are spelled out, so a resource added to the catalog alone
  // would chart under "Unknown".
  it("names a label key for every catalog resource", async () => {
    stubStorage();
    const store = await importStore();
    const unnamed = STAT_RESOURCES.filter(
      (r) => store.statResourceLabelKey(r.id) === "common.unknown",
    ).map((r) => r.id);
    expect(unnamed).toEqual([]);
  });
});
