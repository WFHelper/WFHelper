import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tradeNotificationApi", {
  onShow: (callback: (match: unknown) => void) => {
    const listener = (_event: unknown, match: unknown) => callback(match);
    ipcRenderer.on("trade-notification-show", listener);
    return () => {
      ipcRenderer.removeListener("trade-notification-show", listener);
    };
  },

  dismiss: () => {
    ipcRenderer.send("trade-notification-dismiss");
  },

  onThemeVars: (callback: (vars: unknown) => void) => {
    const listener = (_event: unknown, vars: unknown) => callback(vars);
    ipcRenderer.on("overlay-theme-vars", listener);
    return () => {
      ipcRenderer.removeListener("overlay-theme-vars", listener);
    };
  },
});
