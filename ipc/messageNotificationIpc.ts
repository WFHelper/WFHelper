/**
 * Desktop notification when an in-game whisper arrives. eeLogMonitor detects the
 * new chat tab and the sender's name; this applies the user's settings and reuses
 * the world-cycle desktop notifier with a message-specific sound.
 */

import ctx from "./context";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { normalizeErrorMessage } from "../config/shared/errors";
import * as warframeStatus from "../services/warframeStatus";
import { withScope } from "../services/logger";

const log = withScope("messageNotification");

/**
 * Warframe re-emits `ChatRedux::AddTab` for open whisper tabs every frame while
 * the chat UI is rendering (~30x/s, sustained), and both DBWIN and the file poll
 * deliver each line. Debounce per sender: refresh the timestamp on every hit so a
 * continuous storm collapses to a single toast, and only re-notify after the
 * sender has been quiet for the full window (i.e. a genuinely new conversation).
 */
const NOTIFY_DEBOUNCE_MS = 10_000;
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
    if (ctx.overlaySettings.messageNotificationsEnabled === false) return;

    if (isDuplicate(playerName, Date.now())) return;

    // EE.log can't tell a whisper you SENT from one you RECEIVED - both just open
    // an "F" chat tab. You can only type a message while Warframe is focused, so a
    // tab that appears with the game in the foreground is your own outgoing message
    // (or an incoming one already on screen). Skip those unless the user opts in.
    if (!ctx.overlaySettings.messageNotificationsWhileFocused) {
      const status = await warframeStatus.getStatus({ force: true });
      if (status.isFocused) {
        log.info("[Message] Warframe focused - skipping (self-sent or already visible)");
        return;
      }
    }

    sendDesktopNotificationRaw("New in-game conversation", `from ${playerName}`);
  } catch (err) {
    log.warn("[Message] notify failed:", normalizeErrorMessage(err));
  }
}
