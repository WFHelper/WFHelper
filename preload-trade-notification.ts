import { contextBridge, ipcRenderer } from "electron";
import type { TradeNotificationShowPayload } from "./ipc/tradeNotificationIpc";
import { onIpc } from "./ipc/preloadListeners";
import {
  TRADE_NOTIFICATION_SHOW,
  TRADE_NOTIFICATION_DISMISS,
  OVERLAY_THEME_VARS,
} from "./config/shared/ipcChannels";

export type { TradeNotificationShowPayload };

contextBridge.exposeInMainWorld("tradeNotificationApi", {
  onShow: (callback: (payload: TradeNotificationShowPayload) => void) => {
    return onIpc(ipcRenderer, TRADE_NOTIFICATION_SHOW, (_event, payload) =>
      callback(payload as TradeNotificationShowPayload),
    );
  },

  dismiss: () => {
    ipcRenderer.send(TRADE_NOTIFICATION_DISMISS);
  },

  onThemeVars: (callback: (vars: Record<string, string>) => void) => {
    return onIpc(ipcRenderer, OVERLAY_THEME_VARS, (_event, vars) =>
      callback(vars as Record<string, string>),
    );
  },
});
