import { contextBridge, ipcRenderer } from "electron";
import type { TradeNotificationShowPayload } from "./ipc/tradeNotificationIpc";
import {
  TRADE_NOTIFICATION_SHOW, TRADE_NOTIFICATION_DISMISS, OVERLAY_THEME_VARS,
} from "./config/shared/ipcChannels";

export type { TradeNotificationShowPayload };

contextBridge.exposeInMainWorld("tradeNotificationApi", {
  onShow: (callback: (payload: TradeNotificationShowPayload) => void) => {
    const listener = (_event: unknown, payload: TradeNotificationShowPayload) => callback(payload);
    ipcRenderer.on(TRADE_NOTIFICATION_SHOW, listener);
    return () => {
      ipcRenderer.removeListener(TRADE_NOTIFICATION_SHOW, listener);
    };
  },

  dismiss: () => {
    ipcRenderer.send(TRADE_NOTIFICATION_DISMISS);
  },

  onThemeVars: (callback: (vars: Record<string, string>) => void) => {
    const listener = (_event: unknown, vars: Record<string, string>) => callback(vars);
    ipcRenderer.on(OVERLAY_THEME_VARS, listener);
    return () => {
      ipcRenderer.removeListener(OVERLAY_THEME_VARS, listener);
    };
  },
});
