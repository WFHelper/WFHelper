import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isOrderLimitErrorMessage,
  parseWorkbenchPlan,
  parseWorkbenchSafetySnapshot,
  validateWorkbenchPlan,
  type WorkbenchPlan,
  type WorkbenchPlanRow,
  type WorkbenchReviewReport,
  type WorkbenchSafetySnapshot,
} from "../../config/shared/tradeWorkbenchTypes";
import type { WorkbenchOrderApi } from "../../services/tradeWorkbench";

let tmpDir: string;

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected getPath(${name})`);
      return tmpDir;
    },
  },
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-workbench-test-"));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type Workbench = typeof import("../../services/tradeWorkbench");

async function loadWorkbench(): Promise<Workbench> {
  return import("../../services/tradeWorkbench");
}

function journalFilePath(): string {
  return path.join(tmpDir, "trade-workbench-journal.json");
}

interface JournalOnDisk {
  version: number;
  entries: Array<{
    intentId: string;
    rowId: string;
    mode: string;
    request: Record<string, unknown>;
    outcome?: { status: string; orderId?: string; error?: string };
    resolved?: { classification: string };
  }>;
  overrides: unknown[];
}

function readJournal(): JournalOnDisk {
  return JSON.parse(fs.readFileSync(journalFilePath(), "utf-8")) as JournalOnDisk;
}

function planRow(rowId: string, overrides: Partial<WorkbenchPlanRow> = {}): WorkbenchPlanRow {
  return {
    rowId,
    mode: "create",
    slug: `slug_${rowId}`,
    itemName: `Item ${rowId}`,
    quantity: 1,
    platinum: 10,
    ...overrides,
  };
}

function makePlan(rows: WorkbenchPlanRow[]): WorkbenchPlan {
  return { planId: "plan-1", createdAt: 1000, rows };
}

function snapshotFor(plan: WorkbenchPlan, safe = 99, total = 99): WorkbenchSafetySnapshot {
  const rows: WorkbenchSafetySnapshot["rows"] = {};
  for (const row of plan.rows) rows[row.rowId] = { safe, total };
  return { capturedAt: 2000, rows };
}

interface FakeApiHandle {
  api: WorkbenchOrderApi;
  calls: string[];
}

function fakeApi(overrides: Partial<WorkbenchOrderApi> = {}): FakeApiHandle {
  const calls: string[] = [];
  let counter = 0;
  const api: WorkbenchOrderApi = {
    createOrder: async (params) => {
      calls.push(`create:${params.itemId}:${params.platinum}x${params.quantity}`);
      return { id: `order-${++counter}` };
    },
    updateOrder: async (orderId) => {
      calls.push(`update:${orderId}`);
      return { id: orderId };
    },
    getMyOrders: async () => ({ sell: [] }),
    lookupItemIdBySlug: async (slug) => `id-${slug}`,
    ...overrides,
  };
  return { api, calls };
}

async function waitForRunFinish(workbench: Workbench): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const state = workbench.getWorkbenchState();
    if (state.run?.finishedAt) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("workbench run did not finish");
}

describe("plan validation and parsing", () => {
  it("rejects quantities above the fresh safety snapshot without an override", () => {
    const plan = makePlan([planRow("a", { quantity: 5 })]);
    const result = validateWorkbenchPlan(plan, snapshotFor(plan, 3, 10));
    expect(result.ok).toBe(false);
    expect(result.rows[0]).toEqual({ rowId: "a", ok: false, reason: "over-safe" });
  });

  it("accepts an over-safe quantity only with a recorded override, capped at total", () => {
    const overridden = makePlan([
      planRow("a", { quantity: 5, override: { acknowledgedAt: 1, reasonKeys: ["k"] } }),
    ]);
    expect(validateWorkbenchPlan(overridden, snapshotFor(overridden, 3, 10)).ok).toBe(true);
    // Beyond the account total nothing is sellable, override or not.
    expect(validateWorkbenchPlan(overridden, snapshotFor(overridden, 3, 4)).rows[0].reason).toBe(
      "over-total",
    );
  });

  it("rejects a plan over the per-run cap and rows missing from the snapshot", () => {
    const big = makePlan(Array.from({ length: 21 }, (_, i) => planRow(`r${i}`)));
    expect(validateWorkbenchPlan(big, snapshotFor(big)).planError).toBe("too-many-rows");

    const plan = makePlan([planRow("a")]);
    const missing = validateWorkbenchPlan(plan, { capturedAt: 1, rows: {} });
    expect(missing.rows[0].reason).toBe("missing-safety");
  });

  it("parses only well-formed plans and snapshots", () => {
    expect(parseWorkbenchPlan(null)).toBeNull();
    expect(parseWorkbenchPlan({ planId: "p", createdAt: 1, rows: [{}] })).toBeNull();
    expect(
      parseWorkbenchPlan({
        planId: "p",
        createdAt: 1,
        rows: [{ rowId: "a", mode: "update", slug: "s", itemName: "n", quantity: 1, platinum: 2 }],
      }),
    ).toBeNull(); // update without orderId
    const good = parseWorkbenchPlan({
      planId: "p",
      createdAt: 1,
      rows: [{ rowId: "a", mode: "create", slug: "s", itemName: "n", quantity: 1, platinum: 2 }],
    });
    expect(good?.rows[0].slug).toBe("s");

    expect(
      parseWorkbenchSafetySnapshot({ capturedAt: 1, rows: { a: { safe: -1, total: 2 } } }),
    ).toBeNull();
    const snapshot = parseWorkbenchSafetySnapshot({
      capturedAt: 1,
      rows: { a: { safe: 0, total: 2 }, __proto__: { safe: 9, total: 9 } },
    });
    expect(snapshot?.rows.a).toEqual({ safe: 0, total: 2 });
    expect(Object.keys(snapshot?.rows ?? {})).toEqual(["a"]);
  });

  it("never lets a rowId named after an Object.prototype member skip the cap", () => {
    // "toString" resolved through the prototype chain, so both quantity
    // comparisons read undefined and the row passed uncapped.
    const plan = makePlan([planRow("toString", { quantity: 5 })]);
    expect(validateWorkbenchPlan(plan, { capturedAt: 1, rows: {} }).rows[0]).toEqual({
      rowId: "toString",
      ok: false,
      reason: "missing-safety",
    });
    expect(validateWorkbenchPlan(plan, snapshotFor(plan, 1, 1)).rows[0].reason).toBe("over-total");

    expect(
      parseWorkbenchPlan({
        planId: "p",
        createdAt: 1,
        rows: [
          { rowId: "toString", mode: "create", slug: "s", itemName: "n", quantity: 1, platinum: 2 },
        ],
      }),
    ).toBeNull();
    // planId keys the journal's preexisting-order map the same way.
    expect(
      parseWorkbenchPlan({
        planId: "constructor",
        createdAt: 1,
        rows: [{ rowId: "a", mode: "create", slug: "s", itemName: "n", quantity: 1, platinum: 2 }],
      }),
    ).toBeNull();
  });

  it("recognizes order-limit phrasings and nothing else", () => {
    expect(isOrderLimitErrorMessage("app.post_order.limit_exceeded")).toBe(true);
    expect(isOrderLimitErrorMessage("You have reached the maximum number of orders")).toBe(true);
    expect(isOrderLimitErrorMessage("too many orders")).toBe(true);
    expect(isOrderLimitErrorMessage("invalid item")).toBe(false);
    // A rate limit is transient and scheduler-handled; it must never be
    // mistaken for the account-tier order cap.
    expect(isOrderLimitErrorMessage("Warframe.market rate limit hit. Please wait 30s.")).toBe(
      false,
    );
  });
});

describe("execution engine", () => {
  it("journals the intent before the request leaves (write-ahead ordering)", async () => {
    const workbench = await loadWorkbench();
    const seenBeforeSend: Array<{ entries: number; unsettled: number }> = [];
    const { api } = fakeApi({
      createOrder: async (params) => {
        const journal = readJournal();
        seenBeforeSend.push({
          entries: journal.entries.length,
          unsettled: journal.entries.filter((entry) => !entry.outcome).length,
        });
        return { id: `order-${params.itemId}` };
      },
    });
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });

    const plan = makePlan([planRow("a"), planRow("b")]);
    const result = workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    expect(result.started).toBe(true);
    await waitForRunFinish(workbench);

    // At each send exactly one entry (the current one) was unsettled on disk.
    expect(seenBeforeSend).toEqual([
      { entries: 1, unsettled: 1 },
      { entries: 2, unsettled: 1 },
    ]);
    const journal = readJournal();
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries.every((entry) => entry.outcome?.status === "confirmed")).toBe(true);
    expect(workbench.getWorkbenchState().reviewRequired).toBe(false);
  });

  it("executes strictly sequentially in plan order", async () => {
    const workbench = await loadWorkbench();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const { api } = fakeApi({
      createOrder: async (params) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(params.itemId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { id: `order-${params.itemId}` };
      },
    });
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });

    const plan = makePlan([planRow("a"), planRow("b"), planRow("c")]);
    workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    await waitForRunFinish(workbench);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["id-slug_a", "id-slug_b", "id-slug_c"]);
    expect(workbench.getWorkbenchState().run?.stopReason).toBe("completed");
  });

  it("cancel stops after the in-flight operation and marks the rest cancelled", async () => {
    const workbench = await loadWorkbench();
    let firstSendStarted: (() => void) | null = null;
    const sendStarted = new Promise<void>((resolve) => {
      firstSendStarted = resolve;
    });
    let sends = 0;
    const { api } = fakeApi({
      createOrder: async (params) => {
        sends++;
        firstSendStarted?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { id: `order-${params.itemId}` };
      },
    });
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });

    const plan = makePlan([planRow("a"), planRow("b"), planRow("c")]);
    workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    await sendStarted;
    const cancelling = workbench.cancelWorkbenchRun();
    expect(cancelling.phase).toBe("cancelling");
    await waitForRunFinish(workbench);

    const run = workbench.getWorkbenchState().run;
    expect(run?.stopReason).toBe("cancelled");
    expect(run?.rows.map((row) => row.status)).toEqual(["done", "cancelled", "cancelled"]);
    expect(sends).toBe(1);
    // The finished first row settled its journal entry despite the cancel.
    const journal = readJournal();
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0].outcome?.status).toBe("confirmed");
  });

  it("stops on the order-limit error and blocks remaining rows without retrying", async () => {
    const workbench = await loadWorkbench();
    let creates = 0;
    const { api } = fakeApi({
      createOrder: async (params) => {
        creates++;
        if (creates >= 2) {
          throw new Error("WFMClient v2 API error: app.post_order.limit_exceeded");
        }
        return { id: `order-${params.itemId}` };
      },
    });
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });

    const plan = makePlan([planRow("a"), planRow("b"), planRow("c")]);
    workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    await waitForRunFinish(workbench);

    const run = workbench.getWorkbenchState().run;
    expect(run?.stopReason).toBe("order-limit");
    expect(run?.rows.map((row) => row.status)).toEqual(["done", "failed", "blocked"]);
    expect(creates).toBe(2);
    // The blocked row never produced an intent; the failed one is settled.
    const journal = readJournal();
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[1].outcome?.status).toBe("failed");
    expect(workbench.getWorkbenchState().reviewRequired).toBe(false);
  });

  it("stops when the session dies mid-run", async () => {
    const workbench = await loadWorkbench();
    const { api } = fakeApi({
      createOrder: async () => {
        const err = new Error("Warframe.market session expired or invalid.") as Error & {
          code: string;
        };
        err.code = "WFM_UNAUTHORIZED";
        throw err;
      },
    });
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });

    const plan = makePlan([planRow("a"), planRow("b")]);
    workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    await waitForRunFinish(workbench);
    const run = workbench.getWorkbenchState().run;
    expect(run?.stopReason).toBe("auth");
    expect(run?.rows.map((row) => row.status)).toEqual(["failed", "blocked"]);
  });

  it("fails a row that needs a subtype, names the choices and moves on", async () => {
    const workbench = await loadWorkbench();
    let creates = 0;
    const { api } = fakeApi({
      createOrder: async (params) => {
        creates++;
        if (params.itemId !== "id-slug_a") return { id: "order-b" };
        const err = new Error("warframe.market requires a subtype for this item") as Error & {
          code: string;
          subtypes: string[];
        };
        err.code = "subtype_required";
        err.subtypes = ["intact", "radiant"];
        throw err;
      },
    });
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });

    const plan = makePlan([planRow("a"), planRow("b")]);
    workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    await waitForRunFinish(workbench);

    const run = workbench.getWorkbenchState().run;
    expect(run?.stopReason).toBe("completed");
    expect(run?.rows.map((row) => row.status)).toEqual(["failed", "done"]);
    expect(run?.rows[0].error).toContain("intact, radiant");
    // One attempt for the failed row, one for the next: no retry.
    expect(creates).toBe(2);
    expect(readJournal().entries[0].outcome?.error).toContain("intact, radiant");
  });

  it("refuses the whole plan when any row exceeds its fresh safety cap", async () => {
    const workbench = await loadWorkbench();
    const { api, calls } = fakeApi();
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });

    const plan = makePlan([planRow("a"), planRow("b", { quantity: 4 })]);
    const result = workbench.executeWorkbenchPlan(plan, snapshotFor(plan, 2, 10));
    expect(result.started).toBe(false);
    expect(result.validation?.rows.find((row) => row.rowId === "b")?.reason).toBe("over-safe");
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(journalFilePath())).toBe(false);
  });

  it("uses the existing order surface for update rows", async () => {
    const workbench = await loadWorkbench();
    const { api, calls } = fakeApi();
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });
    const plan = makePlan([planRow("a", { mode: "update", orderId: "ord-9", platinum: 33 })]);
    workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    await waitForRunFinish(workbench);
    expect(calls).toEqual(["update:ord-9"]);
    expect(readJournal().entries[0].outcome?.orderId).toBe("ord-9");
  });
});

describe("journal recovery and review", () => {
  it("a crash between request and response forces review and classifies unknown", async () => {
    const workbench = await loadWorkbench();
    const { api } = fakeApi({
      // The request left but the process "dies" before any response lands.
      createOrder: () => new Promise(() => {}),
    });
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });
    const plan = makePlan([planRow("a")]);
    workbench.executeWorkbenchPlan(plan, snapshotFor(plan));

    // Wait until the write-ahead intent is durable on disk.
    for (let i = 0; i < 1000 && !fs.existsSync(journalFilePath()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(readJournal().entries).toHaveLength(1);

    // Restart: fresh module instance over the same userData.
    vi.resetModules();
    const restarted = await loadWorkbench();
    const { api: freshApi } = fakeApi();
    restarted.configureTradeWorkbench({ api: freshApi });
    restarted.initTradeWorkbench();

    const state = restarted.getWorkbenchState();
    expect(state.reviewRequired).toBe(true);
    expect(state.phase).toBe("review");
    expect(state.unsettledCount).toBe(1);

    // Execution is refused until the user reviews.
    const blocked = restarted.executeWorkbenchPlan(plan, snapshotFor(plan));
    expect(blocked.started).toBe(false);
    expect(blocked.error).toMatch(/review/i);

    const report = await restarted.reconcileWorkbench();
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].classification).toBe("unknown");

    const resolved = restarted.resolveWorkbenchReview({
      resolutions: [{ intentId: report.rows[0].intentId, classification: "failed" }],
    });
    expect(resolved.reviewRequired).toBe(false);
    expect(readJournal().entries[0].resolved?.classification).toBe("failed");
  });

  it("reconciliation classifies against re-fetched live orders", async () => {
    fs.writeFileSync(
      journalFilePath(),
      JSON.stringify({
        version: 1,
        entries: [
          {
            intentId: "i-create-found",
            planId: "p",
            rowId: "a",
            mode: "create",
            request: { slug: "boltor", itemName: "Boltor", platinum: 10, quantity: 1 },
            createdAt: 1,
          },
          {
            intentId: "i-update-stale",
            planId: "p",
            rowId: "b",
            mode: "update",
            request: { slug: "lex", itemName: "Lex", platinum: 25, quantity: 1, orderId: "ord-2" },
            createdAt: 2,
          },
          {
            intentId: "i-update-gone",
            planId: "p",
            rowId: "c",
            mode: "update",
            request: {
              slug: "vasto",
              itemName: "Vasto",
              platinum: 9,
              quantity: 1,
              orderId: "ord-3",
            },
            createdAt: 3,
          },
        ],
        overrides: [],
      }),
    );

    const workbench = await loadWorkbench();
    const { api } = fakeApi({
      getMyOrders: async () => ({
        sell: [
          { id: "ord-1", platinum: 10, quantity: 1, modRank: null, itemUrlName: "boltor" },
          { id: "ord-2", platinum: 20, quantity: 1, modRank: null, itemUrlName: "lex" },
        ],
      }),
    });
    workbench.configureTradeWorkbench({ api });
    workbench.initTradeWorkbench();

    const report = await workbench.reconcileWorkbench();
    const byId = new Map(report.rows.map((row) => [row.intentId, row]));
    expect(byId.get("i-create-found")?.classification).toBe("confirmed");
    expect(byId.get("i-create-found")?.matchedOrderId).toBe("ord-1");
    expect(byId.get("i-update-stale")?.classification).toBe("failed");
    expect(byId.get("i-update-gone")?.classification).toBe("unknown");

    // Reconcile alone settles nothing: review still required.
    expect(workbench.getWorkbenchState().reviewRequired).toBe(true);
  });

  it("a hostile journal file forces review with an error and never executes", async () => {
    fs.writeFileSync(journalFilePath(), "{ this is not json");
    const workbench = await loadWorkbench();
    const { api, calls } = fakeApi();
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });
    workbench.initTradeWorkbench();

    const state = workbench.getWorkbenchState();
    expect(state.journalError).toMatch(/journal/i);
    expect(state.reviewRequired).toBe(true);

    const plan = makePlan([planRow("a")]);
    const result = workbench.executeWorkbenchPlan(plan, snapshotFor(plan));
    expect(result.started).toBe(false);
    expect(calls).toHaveLength(0);
    // The unreadable file is preserved for inspection, not overwritten.
    expect(fs.readFileSync(journalFilePath(), "utf-8")).toBe("{ this is not json");

    // Only an explicit reset replaces it.
    const resolved = workbench.resolveWorkbenchReview({
      resolutions: [],
      resetCorruptJournal: true,
    });
    expect(resolved.journalError).toBeNull();
    expect(resolved.reviewRequired).toBe(false);
    expect(readJournal().entries).toEqual([]);
  });

  it("a well-formed file with malformed entries is treated as corrupt", async () => {
    fs.writeFileSync(
      journalFilePath(),
      JSON.stringify({ version: 1, entries: [{ nonsense: true }], overrides: [] }),
    );
    const workbench = await loadWorkbench();
    workbench.initTradeWorkbench();
    const state = workbench.getWorkbenchState();
    expect(state.journalError).toMatch(/corrupt/i);
    expect(state.reviewRequired).toBe(true);
  });

  it("override acknowledgements are journaled for audit", async () => {
    const workbench = await loadWorkbench();
    workbench.configureTradeWorkbench({ api: fakeApi().api });
    workbench.acknowledgeWorkbenchOverride({
      planId: "p",
      rowId: "a",
      itemName: "Boltor",
      safeQuantity: 1,
      requestedQuantity: 2,
      reasonKeys: ["inventory.safety.reason.lastCopy"],
      acknowledgedAt: 5,
    });
    const journal = readJournal();
    expect(journal.overrides).toHaveLength(1);
  });

  it("drops hand-edited override records that are not well formed", async () => {
    const validAck = {
      planId: "p",
      rowId: "a",
      itemName: "Boltor",
      safeQuantity: 1,
      requestedQuantity: 2,
      reasonKeys: ["inventory.safety.reason.lastCopy"],
      acknowledgedAt: 5,
    };
    fs.writeFileSync(
      journalFilePath(),
      JSON.stringify({
        version: 1,
        entries: [],
        overrides: [
          validAck,
          "junk",
          null,
          7,
          { planId: "p" },
          { ...validAck, requestedQuantity: 0 },
        ],
      }),
    );

    const workbench = await loadWorkbench();
    workbench.configureTradeWorkbench({ api: fakeApi().api });
    workbench.initTradeWorkbench();
    // Junk never fails the journal, so no review is forced by it.
    expect(workbench.getWorkbenchState().reviewRequired).toBe(false);

    workbench.acknowledgeWorkbenchOverride({ ...validAck, rowId: "b", acknowledgedAt: 6 });
    const journal = readJournal();
    expect(journal.overrides).toHaveLength(2);
    expect(journal.overrides).toEqual([validAck, { ...validAck, rowId: "b", acknowledgedAt: 6 }]);
  });
});

describe("review classification evidence", () => {
  function writeJournal(
    entries: Array<Record<string, unknown>>,
    preexistingOrderIds?: Record<string, string[]>,
  ): void {
    fs.writeFileSync(
      journalFilePath(),
      JSON.stringify({
        version: 1,
        entries,
        overrides: [],
        ...(preexistingOrderIds ? { preexistingOrderIds } : {}),
      }),
    );
  }

  function createEntry(request: Record<string, unknown>): Record<string, unknown> {
    return { intentId: "i-1", planId: "p", rowId: "a", mode: "create", request, createdAt: 1 };
  }

  async function classify(
    entries: Array<Record<string, unknown>>,
    sell: Array<Record<string, unknown>>,
    preexistingOrderIds?: Record<string, string[]>,
  ): Promise<WorkbenchReviewReport> {
    writeJournal(entries, preexistingOrderIds);
    const workbench = await loadWorkbench();
    const { api } = fakeApi({
      getMyOrders: async () =>
        ({ sell }) as unknown as Awaited<ReturnType<WorkbenchOrderApi["getMyOrders"]>>,
    });
    workbench.configureTradeWorkbench({ api });
    workbench.initTradeWorkbench();
    return workbench.reconcileWorkbench();
  }

  it("an order that existed before the run never confirms a create", async () => {
    const report = await classify(
      [createEntry({ slug: "boltor", itemName: "Boltor", platinum: 10, quantity: 1 })],
      [{ id: "ord-1", platinum: 10, quantity: 1, modRank: null, itemUrlName: "boltor" }],
      { p: ["ord-1"] },
    );
    expect(report.rows[0].classification).toBe("unknown");
  });

  it("a new order with the same shape still confirms the create", async () => {
    const report = await classify(
      [createEntry({ slug: "boltor", itemName: "Boltor", platinum: 10, quantity: 1 })],
      [
        { id: "ord-1", platinum: 10, quantity: 1, modRank: null, itemUrlName: "boltor" },
        { id: "ord-9", platinum: 10, quantity: 1, modRank: null, itemUrlName: "boltor" },
      ],
      { p: ["ord-1"] },
    );
    expect(report.rows[0].classification).toBe("confirmed");
    expect(report.rows[0].matchedOrderId).toBe("ord-9");
  });

  it("a create is not confirmed by an order of another quantity or subtype", async () => {
    const wrongQuantity = await classify(
      [createEntry({ slug: "boltor", itemName: "Boltor", platinum: 10, quantity: 3 })],
      [{ id: "ord-1", platinum: 10, quantity: 1, modRank: null, itemUrlName: "boltor" }],
    );
    expect(wrongQuantity.rows[0].classification).toBe("unknown");

    const wrongSubtype = await classify(
      [
        createEntry({
          slug: "axi_a1_relic",
          itemName: "Axi A1 Relic",
          platinum: 10,
          quantity: 1,
          subtype: "radiant",
        }),
      ],
      [
        {
          id: "ord-1",
          platinum: 10,
          quantity: 1,
          modRank: null,
          itemUrlName: "axi_a1_relic",
          subtype: "intact",
        },
      ],
    );
    expect(wrongSubtype.rows[0].classification).toBe("unknown");
  });

  it("an update whose quantity change was lost is not reported as confirmed", async () => {
    const report = await classify(
      [
        {
          intentId: "i-1",
          planId: "p",
          rowId: "a",
          mode: "update",
          request: { slug: "lex", itemName: "Lex", platinum: 25, quantity: 4, orderId: "ord-2" },
          createdAt: 1,
        },
      ],
      [{ id: "ord-2", platinum: 25, quantity: 1, modRank: null, itemUrlName: "lex" }],
    );
    expect(report.rows[0].classification).toBe("unknown");
  });

  it("records the pre-run order snapshot when a plan executes", async () => {
    const workbench = await loadWorkbench();
    const { api } = fakeApi();
    workbench.configureTradeWorkbench({ api, interRowDelayMs: 0 });
    const plan: WorkbenchPlan = { ...makePlan([planRow("a")]), knownOrderIds: ["ord-1"] };
    expect(workbench.executeWorkbenchPlan(plan, snapshotFor(plan)).started).toBe(true);
    await waitForRunFinish(workbench);

    const journal = JSON.parse(fs.readFileSync(journalFilePath(), "utf-8")) as {
      preexistingOrderIds?: Record<string, string[]>;
    };
    expect(journal.preexistingOrderIds).toEqual({ "plan-1": ["ord-1"] });
  });

  it("leaves an intent open when the user resolves it as unknown", async () => {
    writeJournal([createEntry({ slug: "boltor", itemName: "Boltor", platinum: 10, quantity: 1 })]);
    const workbench = await loadWorkbench();
    workbench.configureTradeWorkbench({ api: fakeApi().api });
    workbench.initTradeWorkbench();

    const left = workbench.resolveWorkbenchReview({
      resolutions: [{ intentId: "i-1", classification: "unknown" }],
    });
    expect(left.reviewRequired).toBe(true);
    expect(left.unsettledCount).toBe(1);
    expect(readJournal().entries[0].resolved).toBeUndefined();

    const settled = workbench.resolveWorkbenchReview({
      resolutions: [{ intentId: "i-1", classification: "failed" }],
    });
    expect(settled.reviewRequired).toBe(false);
    expect(readJournal().entries[0].resolved?.classification).toBe("failed");
  });
});
