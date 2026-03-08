import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("overlay", {
  close: () => ipcRenderer.send("overlay-close"),
  getRelicItems: () => ipcRenderer.invoke("overlay-get-relic-items"),
  getPrice: (slug: string) => ipcRenderer.invoke("overlay:get-price", slug),
  getThemeVars: () => ipcRenderer.invoke("overlay:get-theme-vars"),
  onTrigger: (cb: () => void) => ipcRenderer.on("relic-reward-trigger", () => cb()),
  onPlannerTrigger: (cb: (payload: unknown) => void) =>
    ipcRenderer.on("relic-planner-trigger", (_event: unknown, payload: unknown) => cb(payload)),
  onItems: (cb: (items: unknown) => void) =>
    ipcRenderer.on("relic-reward-items", (_event: unknown, items: unknown) => cb(items)),
  onRecommendations: (cb: (payload: unknown) => void) =>
    ipcRenderer.on("relic-recommendations", (_event: unknown, payload: unknown) => cb(payload)),
  onThemeVars: (cb: (vars: unknown) => void) =>
    ipcRenderer.on("overlay-theme-vars", (_event: unknown, vars: unknown) => cb(vars)),
  onInteractionMode: (cb: (payload: unknown) => void) =>
    ipcRenderer.on("overlay-interaction-mode", (_event: unknown, payload: unknown) => cb(payload)),
});
