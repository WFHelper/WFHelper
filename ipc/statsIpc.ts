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

function register(): void {
  handleAuthorized(STATS_GET_HISTORY, assertMainRendererSender, () => statsTracker.getHistory());

  handleAuthorized(STATS_GET_CURRENT, assertMainRendererSender, () =>
    statsTracker.getCurrentSession(),
  );

  handleAuthorized(STATS_IMPORT, assertMainRendererSender, (_event, raw: unknown) => {
    if (!Array.isArray(raw)) return { ok: false, count: 0 };
    const count = statsTracker.importHistory(raw as unknown[]);
    return { ok: true, count };
  });

  handleAuthorized(STATS_GET_TRADES, assertMainRendererSender, () => tradeTracker.getTradeLog());

  handleAuthorized(STATS_IMPORT_TRADES, assertMainRendererSender, (_event, raw: unknown) => {
    if (!Array.isArray(raw)) return { ok: false, count: 0 };
    const count = tradeTracker.importTradeLog(raw);
    return { ok: true, count };
  });
}

export { register };
