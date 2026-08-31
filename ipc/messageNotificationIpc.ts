import ctx from "./context";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { normalizeErrorMessage } from "../config/shared/errors";
import * as warframeStatus from "../services/warframeStatus";
import { withScope } from "../services/logger";
import { dispatch } from "../services/notificationChannels";

const log = withScope("messageNotification");

// AddTab repeats through DBWIN and delayed file polling, so debounce per sender.
// Refresh every hit and notify again only after a full quiet window.
const NOTIFY_DEBOUNCE_MS = 30_000;
const lastSeen = new Map<string, number>();

function isDuplicate(playerName: string, now: number): boolean {
  const previous = lastSeen.get(playerName);
  lastSeen.set(playerName, now);
  if (lastSeen.size > 64) {
    for (const [name, ts] of lastSeen) {
      if (now - ts >= NOTIFY_DEBOUNCE_MS) lastSeen.delete(name);
    }
  }
  return previous !== undefined && now - previous < NOTIFY_DEBOUNCE_MS;
}

export async function notifyInGameMessage(playerName: string): Promise<void> {
  try {
    if (isDuplicate(playerName, Date.now())) return;

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
