import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import * as statsTracker from "../services/statsTracker";
import * as tradeTracker from "../services/tradeTracker";
import {
  STATS_GET_HISTORY,
  STATS_GET_CURRENT,
  STATS_IMPORT,
  STATS_GET_TRADES,
  STATS_IMPORT_TRADES,
} from "../config/shared/ipcChannels";
import { isValidStatsImportPayload } from "../config/shared/statsImport";

function register(): void {
  handleAuthorized(STATS_GET_HISTORY, assertMainRendererSender, () => statsTracker.getHistory());

  handleAuthorized(STATS_GET_CURRENT, assertMainRendererSender, () =>
    statsTracker.getCurrentSession(),
  );

  handleAuthorized(STATS_IMPORT, assertMainRendererSender, (_event, raw: unknown) => {
    if (!isValidStatsImportPayload(raw)) return { ok: false, count: 0 };
    const count = statsTracker.importHistory(raw);
    return { ok: true, count };
  });

  // Reads live + archives: finished years leave the live log but stay visible here.
  handleAuthorized(STATS_GET_TRADES, assertMainRendererSender, () =>
    tradeTracker.getRecentTradeLog(),
  );

  handleAuthorized(STATS_IMPORT_TRADES, assertMainRendererSender, (_event, raw: unknown) => {
    if (!Array.isArray(raw)) return { ok: false, count: 0 };
    const count = tradeTracker.importTradeLog(raw);
    return { ok: true, count };
  });
}

export { register };
