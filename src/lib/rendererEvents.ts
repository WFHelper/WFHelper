import { get } from "svelte/store";

import { NOTIFICATION_SOUND_URL } from "./assetUrls.js";
import { invoke, on } from "./ipc.js";
import { log } from "./log.js";
import { onInventoryLoaded } from "./actions.js";
import { tr } from "./i18n.js";
import { handleWfmNotification } from "./wfmNotifications.js";
import { statusText } from "../stores/app.js";
import { pendingArbiRunId, subscribeArbiRunSaved } from "../stores/arbiRuns.js";
import { subscribePtRunSaved } from "../stores/ptRuns.js";
import { currentView } from "../stores/app.js";
import { inventoryModifiedAt, itemDb, parsedItems } from "../stores/data.js";
import { masteryData } from "../stores/mastery.js";
import { applyClosedWfmListing } from "../stores/market.js";
import { addNotificationEntry, loadNotificationHistory } from "../stores/notifications.js";
import { detectedWarframeUiScale } from "../stores/overlaySettings.js";
import { addToast } from "../stores/toasts.js";
import { applyUpdateState } from "../stores/updates.js";

// Reused so a burst decodes the clip once; rewinding also cuts an overlapping replay.
let notificationAudio: HTMLAudioElement | null = null;

/** Main gates on the setting and the burst window, so reaching here means play. */
function playNotificationSound(): void {
  try {
    if (!notificationAudio) notificationAudio = new Audio(NOTIFICATION_SOUND_URL);
    notificationAudio.currentTime = 0;
    // play() rejects when autoplay is refused or the clip cannot be decoded; a
    // missed sound must never break the notification that triggered it.
    void notificationAudio.play().catch((err) => {
      log.warn("[Notify] notification sound blocked:", String(err));
    });
  } catch (err) {
    log.warn("[Notify] notification sound failed:", String(err));
  }
}

async function refreshInventoryModifiedAt(): Promise<void> {
  try {
    const status = await invoke("getInventoryStatus");
    inventoryModifiedAt.set(status?.modifiedAt ?? null);
  } catch {
    // A missing status must not claim the loaded file is fresh.
    inventoryModifiedAt.set(null);
  }
}

/** Main-process events that outlive whichever view happens to be mounted.
 * App.svelte only calls this and disposes it; none of it is layout. */
export function initRendererEvents(): () => void {
  const unsubscribes = [
    subscribeArbiRunSaved(),
    subscribePtRunSaved(),

    on("inventory-updated", async (data) => {
      if (data && !(data as { error?: unknown }).error) {
        await onInventoryLoaded(data);
        // Main only pushes a status on watcher errors and source switches, so the
        // mtime behind this payload has to be pulled.
        await refreshInventoryModifiedAt();
        // SetupView routes itself during the wizard; navigating here would tear it down
        statusText.set({
          key: "app.liveUpdateStatus",
          params: { count: get(parsedItems).length },
        });
      }
    }),

    on("inventory-status-updated", (status) => {
      inventoryModifiedAt.set(status.modifiedAt ?? null);
      if (status.lastError) {
        statusText.set({
          key: "app.inventoryWatcherError",
          params: { error: status.lastError.message },
        });
      } else if (status.found) {
        statusText.set({ key: "app.itemsLoaded", params: { count: get(parsedItems).length } });
      }
    }),

    on("app-update-status", (state) => applyUpdateState(state, true)),

    // Fires when the game saves EE.cfg, so the Settings row tracks in-game
    // interface scale changes live.
    on("warframe-ui-scale-updated", (scale) => detectedWarframeUiScale.set(scale)),

    on("wfm:notification", (notification) => handleWfmNotification(notification, get(tr))),

    // Lives here, not in MarketView: the trade lands while the user is in-game,
    // long before the (lazy) Market tab is mounted.
    on("trade-recorded", (data) => {
      for (const match of data?.wfmMatches ?? []) applyClosedWfmListing(match);
    }),

    // Notifications land while the user is in-game, so the history has to be
    // collected here rather than in the (lazily mounted) modal.
    on("notification-history-added", (entry) => addNotificationEntry(entry)),

    // The toast itself is silent; playing the clip in-app keeps it on the
    // WFHelper mixer slider instead of the system master volume.
    on("notification-sound-play", () => playNotificationSound()),

    // Post-run overlay "Detailed Stats" button: open the arbi tab on that run.
    on("arbi-open-run", (runId) => {
      pendingArbiRunId.set(runId);
      currentView.set("arbi");
    }),

    // DE overlay refresh can add items/icons after startup; re-pull the affected stores.
    on("item-db-updated", async () => {
      const db = await invoke("getItemDatabase");
      itemDb.set(db || {});
      invoke("getMasteryProgress")
        .then((md) => masteryData.set(md))
        .catch((err) => console.warn("[Mastery] getMasteryProgress failed:", err));
    }),
  ];

  // The startup inventory load can predate these subscriptions, so seed the mtime.
  void refreshInventoryModifiedAt();
  void loadNotificationHistory();

  // Main raises each hint once: XWayland failed here, or there is no X server.
  void invoke("getLinuxDisplay").then((display) => {
    const t = get(tr);
    if (display?.fallbackHint) {
      addToast({
        level: "warning",
        title: t("app.overlayFallbackTitle"),
        message: t("app.overlayFallbackMessage"),
        durationMs: 15000,
      });
    } else if (display?.noXServerHint) {
      addToast({
        level: "warning",
        title: t("app.overlayNoXServerTitle"),
        message: t("app.overlayNoXServerMessage"),
        durationMs: 20000,
      });
    }
  });

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
