import path from "node:path";

import { app, Menu, nativeImage, Tray } from "electron";

import { mainMessage } from "./overlayI18n";
import { markQuitting } from "../services/appLifecycle";
import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "../services/logger";

const log = withScope("Tray");

// build/ is not packaged, so the tray reuses the shipped app icon. Windows needs
// the .ico for the notification area; every other platform takes the PNG.
const TRAY_ICON_FILE = process.platform === "win32" ? "logo.ico" : "logo.png";

let tray: Tray | null = null;
let showMainWindow: (() => void) | null = null;
let trayUnavailableLogged = false;

function trayIcon(): string | Electron.NativeImage {
  const file = path.join(app.getAppPath(), "assets", TRAY_ICON_FILE);
  // Windows picks a frame out of the .ico itself. Elsewhere the source is the
  // 974px app logo, and status-area hosts scale something that big badly.
  if (process.platform === "win32") return file;
  return nativeImage.createFromPath(file).resize({ width: 32, height: 32 });
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: mainMessage("tray.show", "Show WFHelper"),
      click: () => showMainWindow?.(),
    },
    { type: "separator" },
    {
      label: mainMessage("tray.quit", "Quit"),
      click: () => {
        markQuitting();
        app.quit();
      },
    },
  ]);
}

/** How the tray restores the window; main owns it because a destroyed window
 *  has to be built again through the normal creation path. */
export function configureTray(show: () => void): void {
  showMainWindow = show;
}

/** Creates the tray, or relabels an existing one after a language change.
 *  False means this session has no tray and closing the window must quit. */
export function createTray(): boolean {
  if (!tray) {
    try {
      tray = new Tray(trayIcon());
    } catch (err) {
      // Some Linux sessions ship no status area at all. Logged once so a
      // settings toggle cannot fill the log with the same failure.
      if (!trayUnavailableLogged) {
        trayUnavailableLogged = true;
        log.warn(
          "[Tray] unavailable, closing the window will quit:",
          normalizeErrorMessage(err, "unknown tray error"),
        );
      }
      return false;
    }
    tray.setToolTip("WFHelper");
    // Linux tray backends deliver no click event, so there the menu is the only way in.
    if (process.platform === "win32") tray.on("click", () => showMainWindow?.());
    log.info("[Tray] created");
  }
  tray.setContextMenu(buildTrayMenu());
  return true;
}

export function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  log.info("[Tray] destroyed");
}

export function isTrayActive(): boolean {
  return tray !== null;
}
