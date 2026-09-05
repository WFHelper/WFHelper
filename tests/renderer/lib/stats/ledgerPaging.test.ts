import { beforeEach, describe, expect, it, vi } from "vitest";

import { LEDGER_QUERY_MAX_LIMIT } from "../../../../config/shared/tradeLedgerTypes.js";
import type { LedgerPage, LedgerQuery } from "../../../../config/shared/tradeLedgerTypes.js";
import type { TradeEvent } from "../../../../config/shared/statsTypes.js";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("../../../../src/lib/ipc.js", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { pageLedgerRange } = await import("../../../../src/lib/stats/ledgerPaging.js");

function event(id: string): TradeEvent {
  return { id, date: "2026-01-01T00:00:00.000Z", type: "sale", platChange: 1, items: [] };
}

/** Serves `total` rows LEDGER_QUERY_MAX_LIMIT at a time, like main does. */
function servePages(total: number): void {
  invokeMock.mockImplementation((_channel: string, query: LedgerQuery): Promise<LedgerPage> => {
    const offset = query.offset ?? 0;
    const limit = query.limit ?? LEDGER_QUERY_MAX_LIMIT;
    const events: TradeEvent[] = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) events.push(event(`e${i}`));
    return Promise.resolve({ events, total, unreadableYears: [] });
  });
}

describe("pageLedgerRange", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("pages the whole window and reports the untruncated total", async () => {
    servePages(450);
    const result = await pageLedgerRange({ from: "2026-01-01" }, 6000);
    expect(result?.events).toHaveLength(450);
    expect(result?.total).toBe(450);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      from: "2026-01-01",
      offset: 0,
      limit: LEDGER_QUERY_MAX_LIMIT,
    });
  });

  it("stops at the row ceiling and still reports what the query matched", async () => {
    servePages(1000);
    const result = await pageLedgerRange({}, 300);
    expect(result?.events).toHaveLength(400);
    expect(result?.total).toBe(1000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("returns null once the caller's load is no longer current", async () => {
    servePages(1000);
    let calls = 0;
    const result = await pageLedgerRange({}, 6000, () => {
      calls += 1;
      return calls < 2;
    });
    expect(result).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("handles an empty window without looping", async () => {
    servePages(0);
    const result = await pageLedgerRange({}, 6000);
    expect(result).toEqual({ events: [], total: 0 });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
