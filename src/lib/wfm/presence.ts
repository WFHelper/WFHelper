import { get } from "svelte/store";

import { tr } from "../i18n.js";
import { invoke, tradeInvoke } from "../ipc.js";
import { log } from "../log.js";
import { marketViewState, setMarketViewState } from "../../stores/market.js";
import { addToast } from "../../stores/toasts.js";
import { normalizeErrorMessage } from "../../../config/shared/errors.js";
import type { WfmStatus } from "../../types/market.js";

/** Manual presence pick. Shared so the Market tab and the titlebar pill cannot
 *  drift on what a pick does to the auto rules. */
export async function setWfmStatus(status: WfmStatus): Promise<void> {
  if (status === get(marketViewState).status) return;
  try {
    const result = await tradeInvoke("wfmSetStatus", status);
    // Main reports a failed change as a value, not as a rejection.
    if ("error" in result) throw new Error(result.error);
    // Main broadcasts the authoritative state (hold expiry) right after.
    setMarketViewState({ status, statusAutoActive: false, statusAwayActive: false });
  } catch (error) {
    log.error("[Market] setStatus failed:", error);
    const message = get(tr)("market.statusChangeFailed", { error: normalizeErrorMessage(error) });
    addToast({ level: "error", message });
  }
}

/** Pulls the authoritative presence from main. It seeds from the public profile
 *  (`/v2/me` omits status) and knows how long the current status is still held. */
export async function refreshWfmPresence(): Promise<void> {
  try {
    const presence = await invoke("wfmPresenceState");
    setMarketViewState({
      status: presence.status,
      statusExpiresAt: presence.expiresAt,
      statusAutoActive: presence.autoActive,
      statusAwayActive: presence.awayActive,
    });
  } catch (error) {
    log.warn("[Market] presence state failed:", error);
  }
}
