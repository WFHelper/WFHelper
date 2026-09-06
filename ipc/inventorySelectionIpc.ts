import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { dispatch } from "../services/notificationChannels";
import { INVENTORY_SELECTION_COMPLETE } from "../config/shared/ipcChannels";

const MAX_NAME_CHARS = 64;
const MAX_OWNED = 10_000;

interface SelectionCompletePayload {
  name: string;
  owned: number;
}

// The renderer owns the saved selections, so the name and count arrive unvetted
// and reach a stored history entry; bound both before anything is written.
function parsePayload(raw: unknown): SelectionCompletePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, owned } = raw as Record<string, unknown>;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_CHARS) return null;
  if (typeof owned !== "number" || !Number.isInteger(owned)) return null;
  if (owned < 1 || owned > MAX_OWNED) return null;
  return { name: trimmed, owned };
}

export function register(): void {
  handleAuthorized(
    INVENTORY_SELECTION_COMPLETE,
    assertMainRendererSender,
    (_event, payload: unknown) => {
      const parsed = parsePayload(payload);
      if (!parsed) return false;
      // English on purpose: the body is kept in the notification history, which
      // a language switch must not rewrite.
      const title = "Bulk sell selection complete";
      const body = `${parsed.name}: all ${parsed.owned} items owned`;
      // Kept on the raw sender's default "app" history kind, which also records the entry.
      dispatch({ source: "inventorySelections", title, body }, () =>
        sendDesktopNotificationRaw(title, body),
      );
      return true;
    },
  );
}
