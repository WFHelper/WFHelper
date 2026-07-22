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
 * Warframe re-emits ChatRedux::AddTab ~30x/s while chat renders, on both DBWIN
 * and the file poll (which trails by up to ~26s). Debounce per sender: refresh
 * the timestamp on every hit, re-notify only after a full quiet window.
 */
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
    if (ctx.overlaySettings.messageNotificationsEnabled === false) return;

    if (isDuplicate(playerName, Date.now())) return;

    // EE.log can't tell a sent whisper from a received one - both open an "F" tab.
    // Typing needs game focus, so a tab appearing while focused is our own outgoing
    // message (or an incoming one already on screen). Skip those unless opted in.
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
