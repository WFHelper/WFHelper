import { screen } from "electron";

import ctx from "./context";
import { computeUiZoomFactor } from "../config/runtime/uiScale";
import { withScope } from "../services/logger";

const log = withScope("Main");

// px sizes are tuned around 1080p; zoom (not root font size) so hardcoded px scale too.
export function applyMainWindowZoom(): void {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    const zoom = computeUiZoomFactor(display?.workArea?.height, ctx.overlaySettings?.uiScale);
    if (win.webContents.getZoomFactor() === zoom) return;
    win.webContents.setZoomFactor(zoom);
    log.info(`[UIScale] main window zoom -> ${zoom}`);
  } catch (err) {
    log.warn("[UIScale] failed to apply main window zoom:", String(err));
  }
}
