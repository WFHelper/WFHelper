import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
  vi.resetModules();
  return await import("../../../../src/lib/tradeWorkbench/queueCache.js");
}

beforeEach(() => vi.resetModules());

describe("workbench queue cache", () => {
  it("starts empty and hands back exactly what was written", async () => {
    const mod = await loadModule();
    expect(mod.readCachedQueueRows()).toEqual([]);

    const rows = [{ rowId: "r0" }] as unknown as Parameters<typeof mod.writeCachedQueueRows>[0];
    mod.writeCachedQueueRows(rows);
    expect(mod.readCachedQueueRows()).toBe(rows);
  });

  it("is process-lifetime only, so a fresh module load starts empty again", async () => {
    const first = await loadModule();
    first.writeCachedQueueRows([{ rowId: "r0" }] as unknown as Parameters<
      typeof first.writeCachedQueueRows
    >[0]);

    const second = await loadModule();
    expect(second.readCachedQueueRows()).toEqual([]);
  });
});
