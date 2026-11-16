import ctx from "./context";
import * as tradeNotificationIpc from "./tradeNotificationIpc";
import { sendDesktopNotificationRaw } from "./worldStateIpc";
import { withScope } from "../services/logger";
import * as tradeTracker from "../services/tradeTracker";
import * as tradeWfmMatcher from "../services/tradeWfmMatcher";
import * as wfmSession from "../services/wfmSession";
import type { ParsedLogTrade } from "../services/eeLogMonitor";
import { isTradeNotificationOverlayEnabled } from "../config/runtime/overlaySettings";
import { TRADE_RECORDED } from "../config/shared/ipcChannels";
import { tradeNotificationBody, tradeNotificationTitle } from "../config/shared/notifications";
import { summarizeMatches, summarizeTrade } from "../config/shared/tradeMatch";
import type { TradeMatchPayload, TradeNotificationStatus } from "../config/shared/tradeMatch";

const log = withScope("tradeWorkflow");

export function handleConfirmedTrade(trade: ParsedLogTrade): void {
  const event = tradeTracker.recordTradeFromLog(trade);
  if (!event) return;

  const win = ctx.mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send(TRADE_RECORDED, { trade: event, wfmMatches: [] });
  }

  void (async () => {
    // The in-game toast is what records history and raises the OS notification,
    // so with the toast switched off this path owns the desktop notification.
    const notify = (status: TradeNotificationStatus, match?: TradeMatchPayload | null) => {
      const payload = match ?? summarizeTrade(event);
      if (isTradeNotificationOverlayEnabled(ctx.overlaySettings)) {
        tradeNotificationIpc.showTradeNotification(payload, status);
        return;
      }
      if (!ctx.overlaySettings.tradeDesktopNotificationsEnabled) return;
      sendDesktopNotificationRaw(
        tradeNotificationTitle(status),
        tradeNotificationBody(payload),
        "trade",
      );
    };

    if (!ctx.overlaySettings.autoCloseWfmOrders || !wfmSession.getToken()) {
      notify("detected");
      return;
    }

    try {
      const matches = await tradeWfmMatcher.matchTradeToOrders(trade);
      if (matches.length === 0) {
        notify("no-match");
        return;
      }

      const closed: TradeMatchPayload[] = [];
      for (const match of matches) {
        if (await tradeWfmMatcher.closeMatchedOrder(match)) closed.push(match);
      }
      if (closed.length === 0) {
        notify("close-failed", summarizeMatches(matches, event));
        return;
      }

      tradeTracker.markTradeWfmClosed(event.id);

      if (win && !win.isDestroyed()) {
        win.webContents.send(TRADE_RECORDED, {
          trade: { ...event, wfmClosed: true },
          wfmMatches: closed,
        });
      }

      notify("closed", summarizeMatches(closed, event));
    } catch (err) {
      // Keep a failed lookup distinct from a checked no-match.
      log.warn("[Trade] Auto-close error:", String(err));
      notify("match-failed");
    }
  })();
}
