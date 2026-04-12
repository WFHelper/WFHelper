import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import * as statsTracker from "../services/statsTracker";
import * as tradeTracker from "../services/tradeTracker";
import { ipcMain } from "electron";
import {
  STATS_GET_HISTORY, STATS_GET_CURRENT, STATS_IMPORT,
  STATS_GET_TRADES, STATS_IMPORT_TRADES,
} from "../config/shared/ipcChannels";

function register(): void {
  ipcMain.handle(STATS_GET_HISTORY, (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, STATS_GET_HISTORY);
    return statsTracker.getHistory();
  });

  ipcMain.handle(STATS_GET_CURRENT, (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, STATS_GET_CURRENT);
    return statsTracker.getCurrentSession();
  });

  ipcMain.handle(STATS_IMPORT, (event: unknown, raw: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, STATS_IMPORT);
    if (!Array.isArray(raw)) return { ok: false, count: 0 };
    const count = statsTracker.importHistory(raw as unknown[]);
    return { ok: true, count };
  });

  ipcMain.handle(STATS_GET_TRADES, (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, STATS_GET_TRADES);
    return tradeTracker.getTradeLog();
  });

  ipcMain.handle(STATS_IMPORT_TRADES, (event: unknown, raw: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, STATS_IMPORT_TRADES);
    if (!Array.isArray(raw)) return { ok: false, count: 0 };
    const count = tradeTracker.importTradeLog(raw as import("../services/tradeTracker").TradeEvent[]);
    return { ok: true, count };
  });
}

export { register };
