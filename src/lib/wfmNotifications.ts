import type { WfmNotification } from "../types/ipc.js";
import type { Translator } from "./i18n.js";
import {
  clearMarketAccountState,
  resetMarketFetchTimes,
  setMarketViewState,
} from "../stores/market.js";
import { addToast } from "../stores/toasts.js";
import { invalidateMarketOrdersRefresh } from "./marketOrdersSync.js";

export function handleWfmNotification(notification: WfmNotification, t: Translator): void {
  if (notification.type === "orders-changed") {
    // MarketView refetches when it is mounted; this covers when it is not. A
    // walk already in flight has to lose its write too, or it republishes the
    // pre-change orders behind the refetch.
    invalidateMarketOrdersRefresh();
    resetMarketFetchTimes();
    return;
  }
  if (notification.type === "presence") {
    // Main drives presence (hold expiry, game launch) while the lazy Market
    // tab may be unmounted - keep the store current either way.
    setMarketViewState({
      status: notification.status,
      statusExpiresAt: notification.expiresAt,
      statusAutoActive: notification.autoActive,
      statusAwayActive: notification.awayActive,
    });
    return;
  }
  if (notification.type === "listener-auth-failed") {
    invalidateMarketOrdersRefresh();
    clearMarketAccountState();
    addToast({
      level: "warning",
      title: t("app.wfmSessionExpiredTitle"),
      message: t("app.wfmSessionExpiredMessage"),
      durationMs: 12000,
    });
    return;
  }
  addToast({
    level: "info",
    title: t("app.wfmDmTitle", { from: notification.from }),
    message: notification.content,
    durationMs: 8000,
  });
}
