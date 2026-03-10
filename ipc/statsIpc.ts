import { assertAuthorizedSender, assertMainRendererSender } from "./ipcSecurity";
import { createRuntimeRequire } from "./runtimeRequire";

const requireRuntime = createRuntimeRequire(__dirname, 1);
const statsTracker = requireRuntime<typeof import("../services/statsTracker")>(
  "services/statsTracker",
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
}

export { register };
