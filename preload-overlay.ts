import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("overlay", {
  close: () => ipcRenderer.send("overlay-close"),
  getRelicItems: () => ipcRenderer.invoke("overlay-get-relic-items"),
  onTrigger: (cb: () => void) => ipcRenderer.on("relic-reward-trigger", () => cb()),
  onItems: (cb: (items: unknown) => void) =>
    ipcRenderer.on("relic-reward-items", (_event: unknown, items: unknown) => cb(items)),
});
