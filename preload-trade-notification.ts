import { contextBridge, ipcRenderer } from "electron";
import type { TradeNotificationShowPayload } from "./ipc/tradeNotificationIpc";
import { onIpcData } from "./ipc/preloadListeners";
import {
  TRADE_NOTIFICATION_SHOW,
  TRADE_NOTIFICATION_DISMISS,
  OVERLAY_THEME_VARS,
} from "./config/shared/ipcChannels";

export type { TradeNotificationShowPayload };

contextBridge.exposeInMainWorld("tradeNotificationApi", {
  onShow: (callback: (payload: TradeNotificationShowPayload) => void) => {
    return onIpcData(ipcRenderer, TRADE_NOTIFICATION_SHOW, callback);
  },

  dismiss: () => {
    ipcRenderer.send(TRADE_NOTIFICATION_DISMISS);
  },

  onThemeVars: (callback: (vars: Record<string, string>) => void) => {
    return onIpcData(ipcRenderer, OVERLAY_THEME_VARS, callback);
  },
});
