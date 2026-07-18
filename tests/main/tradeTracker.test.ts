import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("electron", () => ({
  app: { getPath: () => tmpDir },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/statsTracker", () => ({ incrementTodayTrades: vi.fn() }));
vi.mock("../../services/wfmCatalog", () => ({ lookupByName: vi.fn(() => null) }));

type Tracker = typeof import("../../services/tradeTracker");

async function tracker(): Promise<Tracker> {
  const module = await import("../../services/tradeTracker");
  module.__resetTradeTrackerForTest();
  return module;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-test-"));
});

afterEach(async () => {
  (await import("../../services/tradeTracker")).__resetTradeTrackerForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tradeTracker", () => {
  it("drops malformed persisted entries", async () => {
    const module = await tracker();
    fs.writeFileSync(
      path.join(tmpDir, "trade-log.json"),
      JSON.stringify([
        null,
        { id: "bad", date: "nope", type: "sale", platChange: 10, items: [] },
        {
          id: "valid",
          date: "2026-07-18T10:00:00.000Z",
          type: "sale",
          platChange: 10,
          items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
        },
      ]),
    );

    module.loadTradeLog();
    expect(module.getTradeLog()).toHaveLength(1);
    expect(module.getTradeLog()[0].id).toBe("valid");
  });

  it("rejects malformed imported entries without throwing", async () => {
    const module = await tracker();
    expect(module.importTradeLog([null, {}, { id: "partial" }])).toBe(0);
    expect(module.getTradeLog()).toEqual([]);
  });
});
