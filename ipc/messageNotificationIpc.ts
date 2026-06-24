/**
 * Desktop notification when an in-game whisper
 * arrives. eeLogMonitor detects the new chat tab and the sender's name; this
 * applies the user's settings and reuses the world-cycle desktop notifier.
 */

import ctx from "./context";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { normalizeErrorMessage } from "../config/shared/errors";
import * as warframeStatus from "../services/warframeStatus";
import { withScope } from "../services/logger";

const log = withScope("messageNotification");

export async function notifyInGameMessage(playerName: string): Promise<void> {
  try {
    if (ctx.overlaySettings.messageNotificationsEnabled === false) return;

    if (ctx.overlaySettings.messageNotificationsBackgroundOnly) {
      const status = await warframeStatus.getStatus();
      if (status.isFocused) {
        log.info("[Message] Warframe focused and background-only set - skipping");
        return;
      }
    }

    sendDesktopNotificationRaw("New in-game conversation", `from ${playerName}`);
  } catch (err) {
    log.warn("[Message] notify failed:", normalizeErrorMessage(err));
  }
}
