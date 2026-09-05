import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toLocalDayKey } from "../../config/shared/dayKey";
import type { TradeEvent } from "../../config/shared/statsTypes";

// Nothing is written here: the query path only reads, and a missing ledger
// directory reports no archives.
const tmpDir = path.join(os.tmpdir(), "wfhelper-ledger-daykey");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function event(id: string, date: string): TradeEvent {
  return {
    id,
    date,
    type: "sale",
    platChange: 10,
    items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
  };
}

describe("ledger queries use the shared local day key", () => {
  const NEGATIVE_OFFSET_TZ = "America/New_York";
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    process.env.TZ = NEGATIVE_OFFSET_TZ;
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("matches a row on its local day rather than its UTC day", async () => {
    const store = await import("../../services/tradeLedgerStore");
    store.__resetLedgerStoreForTest();
    const nye = event("nye", "2026-01-01T02:00:00.000Z");
    const local = toLocalDayKey(nye.date);
    expect(local).toBe("2025-12-31");

    expect(
      store.selectLedgerEvents({ from: local, to: local }, [nye]).events.map((e) => e.id),
    ).toEqual(["nye"]);
    expect(store.selectLedgerEvents({ from: "2026-01-01" }, [nye]).events).toEqual([]);
  });

  it("keeps a row with an unusable date out of every bounded window", async () => {
    const store = await import("../../services/tradeLedgerStore");
    store.__resetLedgerStoreForTest();
    const broken = event("broken", "not-a-date");
    expect(store.selectLedgerEvents({ from: "2026-01-01" }, [broken]).events).toEqual([]);
    expect(store.selectLedgerEvents({}, [broken]).events.map((e) => e.id)).toEqual(["broken"]);
  });
});
