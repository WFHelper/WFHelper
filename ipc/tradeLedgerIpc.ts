import fs from "node:fs";

import { dialog } from "electron";

import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import * as tradeTracker from "../services/tradeTracker";
import { previewGdprImportFile, takeStagedImport } from "../services/gdprImport";
import { patchArchivedEvent, queryLedger, selectLedgerEvents } from "../services/tradeLedgerStore";
import { stripPlatformGlyphs } from "../services/tradeLogSanitize";
import { withScope } from "../services/logger";
import { normalizeErrorMessage } from "../config/shared/errors";
import {
  LEDGER_EXPORT,
  LEDGER_IMPORT_APPLY,
  LEDGER_IMPORT_PREVIEW,
  LEDGER_QUERY,
  LEDGER_UPDATE_EVENT,
} from "../config/shared/ipcChannels";
import type { TradeEvent, TradeType } from "../config/shared/statsTypes";
import type {
  LedgerEventPatch,
  LedgerExportOptions,
  LedgerImportPreview,
  LedgerImportResult,
  LedgerPage,
  LedgerQuery,
} from "../config/shared/tradeLedgerTypes";

const log = withScope("tradeLedgerIpc");

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_LENGTH = 100;
const MAX_ID_LENGTH = 180;
const MAX_PLAT = 10_000_000;
const MAX_CURRENCY = 10_000_000_000;
/** Ceiling on one export file so a bad query cannot write GBs. */
const MAX_EXPORT_ROWS = 100_000;

const EMPTY_PAGE: LedgerPage = { events: [], total: 0, unreadableYears: [] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asDateOnly(value: unknown): string | null {
  return typeof value === "string" && DATE_ONLY.test(value) ? value : null;
}

function asTradeType(value: unknown): TradeType | null {
  return value === "sale" || value === "purchase" || value === "trade" ? value : null;
}

function asBoundedInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= min && rounded <= max ? rounded : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseQuery(raw: unknown): LedgerQuery {
  const record = asRecord(raw);
  if (!record) return {};
  const from = asDateOnly(record.from);
  const to = asDateOnly(record.to);
  const type = asTradeType(record.type);
  const text =
    typeof record.text === "string" && record.text.trim()
      ? record.text.trim().slice(0, MAX_TEXT_LENGTH)
      : null;
  // Paging bounds and their fallbacks belong to queryLedger; this only keeps
  // non-numbers out so the store never has to guess what a caller meant.
  const offset = asFiniteNumber(record.offset);
  const limit = asFiniteNumber(record.limit);
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(type ? { type } : {}),
    ...(text ? { text } : {}),
    ...(offset != null ? { offset } : {}),
    ...(limit != null ? { limit } : {}),
  };
}

/** Null means the patch carried nothing valid, so the row is left alone. */
function parsePatch(raw: unknown): LedgerEventPatch | null {
  const record = asRecord(raw);
  if (!record) return null;
  const patch: LedgerEventPatch = {};
  if (record.platChange !== undefined) {
    const platChange = asBoundedInt(record.platChange, 0, MAX_PLAT);
    if (platChange == null) return null;
    patch.platChange = platChange;
  }
  // null is the editor clearing a field; anything else must be a bounded integer.
  if (record.credits === null) patch.credits = null;
  else if (record.credits !== undefined) {
    const credits = asBoundedInt(record.credits, 0, MAX_CURRENCY);
    if (credits == null) return null;
    patch.credits = credits;
  }
  if (record.tradeTax === null) patch.tradeTax = null;
  else if (record.tradeTax !== undefined) {
    const tradeTax = asBoundedInt(record.tradeTax, 0, MAX_CURRENCY);
    if (tradeTax == null) return null;
    patch.tradeTax = tradeTax;
  }
  if (record.type !== undefined) {
    const type = asTradeType(record.type);
    if (!type) return null;
    patch.type = type;
  }
  if (record.partner !== undefined) {
    if (typeof record.partner !== "string" || record.partner.length > 120) return null;
    // An edited partner takes the same glyph strip as a captured one, or a
    // pasted console name would join against nothing.
    patch.partner = stripPlatformGlyphs(record.partner.trim());
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function parseExportOptions(raw: unknown): LedgerExportOptions | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (record.format !== "csv" && record.format !== "json") return null;
  const from = asDateOnly(record.from);
  const to = asDateOnly(record.to);
  return {
    format: record.format,
    includePartners: record.includePartners === true,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

function itemsCell(event: TradeEvent): string {
  return event.items
    .map(
      (item) => `${item.count > 1 ? `${item.count}x ` : ""}${item.displayName} (${item.direction})`,
    )
    .join("; ");
}

// A leading formula character makes a spreadsheet execute the cell on open.
function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function toCsv(events: TradeEvent[], includePartners: boolean): string {
  const header = ["date", "type", "platinum", "credits", "tradeTax", "items", "source", "id"];
  if (includePartners) header.splice(5, 0, "partner");
  const lines = [header.map(csvCell).join(",")];
  for (const event of events) {
    const cells: (string | number | undefined)[] = [
      event.date,
      event.type,
      event.platChange,
      event.credits,
      event.tradeTax,
      itemsCell(event),
      event.source ?? "live",
      event.id,
    ];
    if (includePartners) cells.splice(5, 0, event.partner ?? "");
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function stripPartners(events: TradeEvent[], includePartners: boolean): TradeEvent[] {
  if (includePartners) return events;
  return events.map((event) => {
    const copy = { ...event };
    delete copy.partner;
    return copy;
  });
}

function register(): void {
  handleAuthorized(LEDGER_QUERY, assertMainRendererSender, (_event, raw: unknown): LedgerPage => {
    try {
      return queryLedger(parseQuery(raw), tradeTracker.getTradeLog());
    } catch (err) {
      log.warn("[Ledger] Query failed:", normalizeErrorMessage(err));
      return EMPTY_PAGE;
    }
  });

  handleAuthorized(
    LEDGER_IMPORT_PREVIEW,
    assertMainRendererSender,
    async (): Promise<LedgerImportPreview | { error: string }> => {
      if (!ctx.mainWindow) return { error: "No window is available for the file dialog." };
      const picked = await dialog.showOpenDialog(ctx.mainWindow, {
        title: "Import trade history",
        filters: [
          { name: "Trade export", extensions: ["json", "csv"] },
          { name: "All files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });
      if (picked.canceled || picked.filePaths.length === 0) return { error: "" };
      try {
        return previewGdprImportFile(picked.filePaths[0], tradeTracker.getLedgerEvents());
      } catch (err) {
        log.warn("[Ledger] Import preview failed:", normalizeErrorMessage(err));
        return { error: "Could not read this trade export." };
      }
    },
  );

  handleAuthorized(
    LEDGER_IMPORT_APPLY,
    assertMainRendererSender,
    (_event, batchId: unknown): LedgerImportResult => {
      if (typeof batchId !== "string" || !batchId || batchId.length > MAX_ID_LENGTH) {
        return { applied: 0, skippedDuplicates: 0, error: "Invalid import batch." };
      }
      const staged = takeStagedImport(batchId);
      if (!staged) {
        return { applied: 0, skippedDuplicates: 0, error: "This import preview has expired." };
      }
      try {
        return tradeTracker.addLedgerEvents(staged);
      } catch (err) {
        log.warn("[Ledger] Import apply failed:", normalizeErrorMessage(err));
        return { applied: 0, skippedDuplicates: 0, error: "Writing the imported rows failed." };
      }
    },
  );

  handleAuthorized(
    LEDGER_UPDATE_EVENT,
    assertMainRendererSender,
    (_event, id: unknown, rawPatch: unknown): { ok: boolean; error?: string } => {
      if (typeof id !== "string" || !id || id.length > MAX_ID_LENGTH) {
        return { ok: false, error: "Invalid row id." };
      }
      const patch = parsePatch(rawPatch);
      if (!patch) return { ok: false, error: "Invalid edit." };
      try {
        if (tradeTracker.patchLiveTradeEvent(id, patch)) return { ok: true };
        if (patchArchivedEvent(id, patch)) return { ok: true };
        return { ok: false, error: "That trade is no longer in the ledger." };
      } catch (err) {
        log.warn("[Ledger] Row update failed:", normalizeErrorMessage(err));
        return { ok: false, error: "Saving the edit failed." };
      }
    },
  );

  handleAuthorized(
    LEDGER_EXPORT,
    assertMainRendererSender,
    async (
      _event,
      rawOptions: unknown,
    ): Promise<{ saved: boolean; path?: string; error?: string }> => {
      const options = parseExportOptions(rawOptions);
      if (!options) return { saved: false, error: "Invalid export options." };
      if (!ctx.mainWindow) return { saved: false, error: "No window is available." };

      const query: LedgerQuery = {
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
      };
      let events: TradeEvent[];
      try {
        events = selectLedgerEvents(query, tradeTracker.getTradeLog()).events.slice(
          0,
          MAX_EXPORT_ROWS,
        );
      } catch (err) {
        log.warn("[Ledger] Export query failed:", normalizeErrorMessage(err));
        return { saved: false, error: "Reading the ledger failed." };
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const picked = await dialog.showSaveDialog(ctx.mainWindow, {
        defaultPath: `wfhelper-trade-ledger-${stamp}.${options.format}`,
        filters: [
          options.format === "csv"
            ? { name: "CSV", extensions: ["csv"] }
            : { name: "JSON", extensions: ["json"] },
        ],
      });
      if (picked.canceled || !picked.filePath) return { saved: false };

      try {
        const body =
          options.format === "csv"
            ? toCsv(events, options.includePartners)
            : JSON.stringify(stripPartners(events, options.includePartners), null, 2);
        fs.writeFileSync(picked.filePath, body, "utf-8");
        log.info(`[Ledger] Exported ${events.length} row(s) as ${options.format}`);
        return { saved: true, path: picked.filePath };
      } catch (err) {
        log.warn("[Ledger] Export write failed:", normalizeErrorMessage(err));
        return { saved: false, error: "Writing the export file failed." };
      }
    },
  );
}

export { register };
