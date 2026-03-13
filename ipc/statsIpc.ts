import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { createRuntimeRequire } from "./runtimeRequire";

const requireRuntime = createRuntimeRequire(__dirname, 1);
const statsTracker = requireRuntime<typeof import("../services/statsTracker")>(
  "services/statsTracker",
);
const tradeTracker = requireRuntime<typeof import("../services/tradeTracker")>(
  "services/tradeTracker",
);

const { ipcMain } = require("electron") as typeof import("electron");

function register(): void {
  ipcMain.handle("stats:get-history", (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "stats:get-history");
    return statsTracker.getHistory();
  });

  ipcMain.handle("stats:get-current", (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "stats:get-current");
    return statsTracker.getCurrentSession();
  });

  ipcMain.handle("stats:import", (event: unknown, raw: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "stats:import");
    if (!Array.isArray(raw)) return { ok: false, count: 0 };
    const count = statsTracker.importHistory(raw as unknown[]);
    return { ok: true, count };
  });

  ipcMain.handle("stats:get-trades", (event: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "stats:get-trades");
    return tradeTracker.getTradeLog();
  });

  ipcMain.handle("stats:import-trades", (event: unknown, raw: unknown) => {
    assertAuthorizedSender(assertMainRendererSender, event as never, "stats:import-trades");
    if (!Array.isArray(raw)) return { ok: false, count: 0 };
    const count = tradeTracker.importTradeLog(raw as import("../services/tradeTracker").TradeEvent[]);
    return { ok: true, count };
  });
}

export { register };
