import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEvent, makeWindowStub } from "./senderGuardHelpers";
import type { LedgerImportPreview, LedgerPage } from "../../config/shared/tradeLedgerTypes";
import type { TradeEvent } from "../../config/shared/statsTypes";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
interface OpenOptions {
  title?: string;
  filters?: { name: string }[];
}
const handlers = new Map<string, Handler>();
let tmpDir: string;
let savePath: string | undefined;
let openOptions: OpenOptions | null = null;

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: !savePath, filePath: savePath })),
    showOpenDialog: vi.fn(async (_window: unknown, options: OpenOptions) => {
      openOptions = options;
      return { canceled: true, filePaths: [] };
    }),
  },
  app: { getPath: () => tmpDir },
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../services/statsTracker", () => ({ incrementTodayTrades: vi.fn() }));
vi.mock("../../services/wfmCatalog", () => ({ lookupByName: vi.fn(() => null) }));

const MAIN_URL = "file:///D:/app/renderer/dist/index.html";
const YEAR = new Date().getUTCFullYear();

function event(id: string, date: string, extra: Partial<TradeEvent> = {}): TradeEvent {
  return {
    id,
    date,
    type: "sale",
    platChange: 10,
    items: [{ internalName: "", displayName: "Forma", count: 1, direction: "given" }],
    partner: "Kestrel",
    ...extra,
  };
}

async function setup() {
  const ctx = (await import("../../ipc/context")).default;
  const tracker = await import("../../services/tradeTracker");
  const store = await import("../../services/tradeLedgerStore");
  tracker.__resetTradeTrackerForTest();
  store.__resetLedgerStoreForTest();
  fs.writeFileSync(
    path.join(tmpDir, "trade-log.json"),
    JSON.stringify([
      event("a", `${YEAR}-05-05T10:00:00.000Z`),
      event("b", `${YEAR}-06-06T10:00:00.000Z`, { type: "purchase", partner: "Vor" }),
    ]),
  );
  tracker.loadTradeLog();
  const ledgerIpc = await import("../../ipc/tradeLedgerIpc");
  handlers.clear();
  ledgerIpc.register();
  ctx.mainWindow = makeWindowStub(11);
  return { ctx, tracker };
}

// handleAuthorized wraps every handler in an async function, so results are promises.
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler(makeEvent(11, MAIN_URL), ...args);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ipc-test-"));
  savePath = undefined;
  openOptions = null;
});

afterEach(async () => {
  const ctx = (await import("../../ipc/context")).default;
  ctx.mainWindow = null;
  const tracker = await import("../../services/tradeTracker");
  const store = await import("../../services/tradeLedgerStore");
  tracker.__resetTradeTrackerForTest();
  store.__resetLedgerStoreForTest();
  handlers.clear();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ledger IPC boundary", () => {
  it("registers every ledger channel", async () => {
    await setup();
    expect([...handlers.keys()].sort()).toEqual([
      "ledger:export",
      "ledger:import-apply",
      "ledger:import-preview",
      "ledger:query",
      "ledger:update-event",
    ]);
  });

  it("survives junk queries and clamps the page size", async () => {
    await setup();
    expect(((await invoke("ledger:query", null)) as LedgerPage).total).toBe(2);
    expect(((await invoke("ledger:query", "nope")) as LedgerPage).total).toBe(2);
    const page = (await invoke("ledger:query", {
      limit: 9_999,
      offset: -3,
      from: "garbage",
      type: "not-a-type",
      text: 42,
    })) as LedgerPage;
    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(2);
  });

  it("applies a valid patch and rejects an out-of-range one", async () => {
    const { tracker } = await setup();
    expect(await invoke("ledger:update-event", "a", { platChange: 77 })).toEqual({ ok: true });
    expect(tracker.getTradeLog().find((e) => e.id === "a")?.platChange).toBe(77);

    expect(await invoke("ledger:update-event", "a", { platChange: -1 })).toEqual({
      ok: false,
      error: "invalidPatch",
    });
    expect(await invoke("ledger:update-event", "a", { type: "gift" })).toEqual({
      ok: false,
      error: "invalidPatch",
    });
    expect(await invoke("ledger:update-event", "", { platChange: 1 })).toEqual({
      ok: false,
      error: "invalidId",
    });
    expect(await invoke("ledger:update-event", "nope", { platChange: 1 })).toEqual({
      ok: false,
      error: "rowGone",
    });
    // The rejected patches left the row alone.
    expect(tracker.getTradeLog().find((e) => e.id === "a")?.platChange).toBe(77);
  });

  it("unsets credits and tax when the patch carries null", async () => {
    const { tracker } = await setup();
    expect(await invoke("ledger:update-event", "a", { credits: 1200, tradeTax: 500 })).toEqual({
      ok: true,
    });
    let row = tracker.getTradeLog().find((e) => e.id === "a");
    expect(row?.credits).toBe(1200);
    expect(row?.tradeTax).toBe(500);

    expect(await invoke("ledger:update-event", "a", { credits: null, tradeTax: null })).toEqual({
      ok: true,
    });
    row = tracker.getTradeLog().find((e) => e.id === "a");
    expect(row?.credits).toBeUndefined();
    expect(row?.tradeTax).toBeUndefined();
  });

  it("takes the id and the patch as the two positional args the preload sends", async () => {
    const { tracker } = await setup();
    const preload = fs.readFileSync(path.join(__dirname, "..", "..", "preload.ts"), "utf-8");
    // The bridge must not wrap the args in one object: the handler reads them
    // positionally, and a wrapped payload only ever answered "Invalid row id.".
    expect(preload).toContain('ledgerUpdateEvent: inv<"ledgerUpdateEvent">(LEDGER_UPDATE_EVENT)');
    expect(preload).not.toMatch(/LEDGER_UPDATE_EVENT,\s*\{/);

    expect(await invoke("ledger:update-event", "a", { platChange: 5 })).toEqual({ ok: true });
    expect(tracker.getTradeLog().find((e) => e.id === "a")?.platChange).toBe(5);
  });

  it("strips platform glyphs from an edited partner name", async () => {
    const { tracker } = await setup();
    expect(await invoke("ledger:update-event", "a", { partner: "\uE000 Kestrel " })).toEqual({
      ok: true,
    });
    expect(tracker.getTradeLog().find((e) => e.id === "a")?.partner).toBe("Kestrel");
  });

  it("rejects an unknown import batch", async () => {
    await setup();
    expect(await invoke("ledger:import-apply", 7)).toEqual({
      applied: 0,
      skippedDuplicates: 0,
      error: "invalidBatch",
    });
    expect(await invoke("ledger:import-apply", "no-such-batch")).toEqual({
      applied: 0,
      skippedDuplicates: 0,
      error: "batchGone",
    });
  });

  // A sentence from main cannot be translated, so every failure must answer
  // with a code the renderer owns the wording for.
  it("answers a cancelled file dialog with a code, not an empty error", async () => {
    await setup();
    expect(await invoke("ledger:import-preview")).toEqual({ error: "cancelled" });
  });

  it("takes the import dialog title from the message catalogue", async () => {
    await setup();
    const { setOverlayLocale } = await import("../../ipc/overlayI18n");
    const de = (await import("../../src/i18n/de.json")).default;
    setOverlayLocale("de");
    try {
      await invoke("ledger:import-preview");
      expect(openOptions?.title).toBe(de["analysis.importTitle"]);
    } finally {
      setOverlayLocale("en");
    }
  });

  it("writes CSV without partners when the option is off", async () => {
    await setup();
    savePath = path.join(tmpDir, "out.csv");
    const result = (await invoke("ledger:export", {
      format: "csv",
      includePartners: false,
    })) as { saved: boolean };
    expect(result.saved).toBe(true);

    const csv = fs.readFileSync(savePath, "utf-8");
    expect(csv).not.toContain("Kestrel");
    expect(csv.split("\r\n")[0]).not.toContain("partner");
    expect(csv).toContain("Forma (given)");
  });

  // The renderer suite has no Svelte compiler, so the Apply gate is read from
  // the source; what the apply path writes is proved in gdprImport.test.ts.
  it("gates the import dialog on every row the apply path writes", () => {
    const dialogSource = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "src",
        "components",
        "analysis",
        "AnalysisImportDialog.svelte",
      ),
      "utf-8",
    );
    expect(dialogSource).toContain("preview.counts.parsed + preview.counts.unresolved");
    // Gating on the parsed count alone refused an export whose item names are
    // all outside the catalog, and under-reported the button count.
    expect(dialogSource).not.toContain("preview.counts.parsed <=");
    expect(dialogSource).toContain('$tr("analysis.importApply", { count: applicable })');
  });

  it("keeps partners in JSON when asked and refuses a bad format", async () => {
    await setup();
    savePath = path.join(tmpDir, "out.json");
    const result = (await invoke("ledger:export", {
      format: "json",
      includePartners: true,
    })) as { saved: boolean };
    expect(result.saved).toBe(true);
    const rows: TradeEvent[] = JSON.parse(fs.readFileSync(savePath, "utf-8"));
    expect(rows.map((row) => row.partner)).toContain("Kestrel");

    expect(await invoke("ledger:export", { format: "xlsx", includePartners: true })).toEqual({
      saved: false,
      error: "invalidOptions",
    });
  });
});
