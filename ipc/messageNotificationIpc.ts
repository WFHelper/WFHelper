import ctx from "./context";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { normalizeErrorMessage } from "../config/shared/errors";
import * as warframeStatus from "../services/warframeStatus";
import { withScope } from "../services/logger";
import { dispatch } from "../services/notificationChannels";

const log = withScope("messageNotification");

export async function notifyInGameMessage(playerName: string): Promise<void> {
  try {
    // EE.log cannot distinguish sent and received whisper tabs. Treat tabs opened
    // while the game is focused as outgoing unless the user opted in.
    if (!ctx.overlaySettings.messageNotificationsWhileFocused) {
      const status = await warframeStatus.getStatus({ force: true });
      if (status.isFocused) {
        log.info("[Message] Warframe focused - skipping (self-sent or already visible)");
        return;
      }
    }

    const title = "New in-game conversation";
    const body = `from ${playerName}`;
    dispatch({ source: "whisper", title, body }, () => {
      if (ctx.overlaySettings.messageNotificationsEnabled === false) return;
      sendDesktopNotificationRaw(title, body, "message");
    });
  } catch (err) {
    log.warn("[Message] notify failed:", normalizeErrorMessage(err));
  }
}
