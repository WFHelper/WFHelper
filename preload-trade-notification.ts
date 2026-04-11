import { contextBridge, ipcRenderer } from "electron";
import type { TradeNotificationShowPayload } from "./ipc/tradeNotificationIpc";

export type { TradeNotificationShowPayload };

contextBridge.exposeInMainWorld("tradeNotificationApi", {
  onShow: (callback: (payload: TradeNotificationShowPayload) => void) => {
    const listener = (_event: unknown, payload: TradeNotificationShowPayload) => callback(payload);
    ipcRenderer.on("trade-notification-show", listener);
    return () => {
      ipcRenderer.removeListener("trade-notification-show", listener);
    };
  },

  dismiss: () => {
    ipcRenderer.send("trade-notification-dismiss");
  },

  onThemeVars: (callback: (vars: Record<string, string>) => void) => {
    const listener = (_event: unknown, vars: Record<string, string>) => callback(vars);
    ipcRenderer.on("overlay-theme-vars", listener);
    return () => {
      ipcRenderer.removeListener("overlay-theme-vars", listener);
    };
  },
});
