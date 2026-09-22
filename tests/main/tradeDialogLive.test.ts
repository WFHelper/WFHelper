import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  forceEeLogPoll,
  startWatching,
  stopWatching,
  type ParsedLogTrade,
} from "../../services/eeLogMonitor";

const hoisted = vi.hoisted(() => ({
  logPath: "",
  emitDbwinLine: null as ((line: string) => void) | null,
}));

// A real watcher would follow the fixture file; this test feeds lines itself.
vi.mock("chokidar", () => ({
  default: { watch: () => ({ on: () => undefined, close: () => undefined }) },
}));

vi.mock("../../services/eeLogPath", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/eeLogPath")>()),
  resolveEeLogPath: () => hoisted.logPath,
}));

vi.mock("../../services/dbwinMonitor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/dbwinMonitor")>()),
  isDbwinActive: () => true,
  startDbwinWorker: (onLine: (line: string) => void) => {
    hoisted.emitDbwinLine = onLine;
  },
  stopDbwinWorker: () => undefined,
}));

const ORIGINAL_PLATFORM = process.platform;
const GLYPH = String.fromCharCode(0xe000);
const DIALOG_HEAD =
  "2416.657 Script [Info]: Dialog.lua: Dialog::CreateOkCancel(description=" +
  "Are you sure you want to accept this trade? You are offering:";
const DIALOG_TAIL = ", title= leftItem=/Menu/Confirm_Item_Ok, rightItem=/Menu/Confirm_Item_Cancel)";
const NEXT_ENTRY = "2416.702 Sys [Info]: Fade out complete";
const PREVIOUS_DIALOG =
  "2410.104 Script [Info]: Dialog.lua: Dialog::CreateOk(description=Trade request accepted" +
  ", title= leftItem=/Menu/Confirm_Item_Ok)";
const SUCCESS_LINE =
  "2420.118 Script [Info]: Dialog.lua: Dialog::CreateOk(description=The trade was successful!" +
  ", title= leftItem=/Menu/Confirm_Item_Ok)";

// The reported Vicious Bond sale as the log reader hands it over: the game
// separates description lines with a bare CR and flushed the next entry behind
// the platinum line, so that entry shares the platinum line's file line.
const REPORTED_SALE_LINES = [
  DIALOG_HEAD,
  "\rVicious Bond (RARE RANK 0)",
  "",
  "and will receive from RendiW" + GLYPH + " the following:",
  "\rPlatinum x 12" + DIALOG_TAIL + "\r" + NEXT_ENTRY,
];

const REPORTED_SALE = {
  type: "sale",
  platChange: 12,
  partner: "RendiW",
  items: [{ displayName: "Vicious Bond (RARE RANK 0)", count: 1, direction: "given" }],
};

describe("trade dialog dispatch through the line handler", () => {
  let tmpDir = "";
  let trades: ParsedLogTrade[] = [];

  function emit(line: string): void {
    if (!hoisted.emitDbwinLine) throw new Error("dbwin worker was never started");
    hoisted.emitDbwinLine(line);
  }

  function appendToLog(lines: string[]): void {
    fs.appendFileSync(hoisted.logPath, lines.join("\n") + "\n");
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-trade-live-"));
    hoisted.logPath = path.join(tmpDir, "EE.log");
    fs.writeFileSync(hoisted.logPath, "");
    hoisted.emitDbwinLine = null;
    trades = [];
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.useFakeTimers();
    startWatching({
      onTradeConfirmed: (trade) => {
        trades.push(trade);
      },
    });
  });

  afterEach(() => {
    stopWatching();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads the platinum line even when the next log entry is glued behind it", () => {
    for (const line of REPORTED_SALE_LINES) emit(line);
    emit(SUCCESS_LINE);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject(REPORTED_SALE);
  });

  it("reads the same sale from the file poll", () => {
    appendToLog(REPORTED_SALE_LINES);
    forceEeLogPoll();
    appendToLog([SUCCESS_LINE]);
    forceEeLogPoll();

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject(REPORTED_SALE);
  });

  it("still seals the dialog at a log entry on its own line", () => {
    emit(DIALOG_HEAD);
    emit("\rVicious Bond (RARE RANK 0)");
    emit("and will receive from RendiW the following:");
    emit("\rPlatinum x 12" + DIALOG_TAIL);
    emit(NEXT_ENTRY);
    emit("Arcane Energize (LEGENDARY RANK 5)");
    emit(SUCCESS_LINE);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ type: "sale", platChange: 12 });
    expect(trades[0].items.map((item) => item.displayName)).toEqual(["Vicious Bond (RARE RANK 0)"]);
  });

  it("keeps an item line that the next entry was glued behind", () => {
    emit(DIALOG_HEAD);
    emit("\rVicious Bond (RARE RANK 0)\r" + NEXT_ENTRY);
    emit("and will receive from RendiW the following:");
    emit("\rPlatinum x 12" + DIALOG_TAIL);
    emit(SUCCESS_LINE);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ type: "sale", platChange: 12 });
    expect(trades[0].items.map((item) => item.displayName)).toEqual(["Vicious Bond (RARE RANK 0)"]);
  });

  it("does not take what follows a glued entry on the same line for items", () => {
    emit(DIALOG_HEAD);
    emit("\rVicious Bond (RARE RANK 0)\r" + NEXT_ENTRY + "\rArcane Energize (LEGENDARY RANK 5)");
    emit("and will receive from RendiW the following:");
    emit("\rPlatinum x 12" + DIALOG_TAIL);
    emit(SUCCESS_LINE);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ type: "sale", platChange: 12 });
    expect(trades[0].items.map((item) => item.displayName)).toEqual(["Vicious Bond (RARE RANK 0)"]);
  });

  it("cuts an unsealed dialog at the glue when its tail never arrives", () => {
    emit(DIALOG_HEAD);
    emit("\rVicious Bond (RARE RANK 0)");
    emit("and will receive from RendiW the following:");
    emit("\rPlatinum x 12\r" + NEXT_ENTRY);
    emit("Arcane Energize (LEGENDARY RANK 5)");
    emit(SUCCESS_LINE);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject(REPORTED_SALE);
  });

  it("reads a dialog whose start line follows a previous dialog's tail", () => {
    emit(PREVIOUS_DIALOG + "\r" + DIALOG_HEAD);
    for (const line of REPORTED_SALE_LINES.slice(1)) emit(line);
    emit(SUCCESS_LINE);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject(REPORTED_SALE);
  });

  it("seals a single-line dialog at once", () => {
    emit(
      [
        DIALOG_HEAD,
        "Vicious Bond (RARE RANK 0)",
        "and will receive from RendiW the following:",
        "Platinum x 12" + DIALOG_TAIL,
      ].join("\r"),
    );
    emit("Arcane Energize (LEGENDARY RANK 5)");
    emit(SUCCESS_LINE);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject(REPORTED_SALE);
  });
});
