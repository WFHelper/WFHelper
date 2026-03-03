import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cropDebug", {
  close: () => ipcRenderer.send("crop-debug-close"),
  applySelection: (selection: { cropTopRatio: number; cropHeightRatio: number }) =>
    ipcRenderer.invoke("overlay:apply-crop-selection", selection),
  onInit: (cb: (payload: unknown) => void) =>
    ipcRenderer.on("crop-debug:init", (_event: unknown, payload: unknown) => cb(payload)),
  onApplied: (cb: (payload: unknown) => void) =>
    ipcRenderer.on("crop-debug:applied", (_event: unknown, payload: unknown) => cb(payload)),
});