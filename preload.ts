import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getInventory: () => ipcRenderer.invoke("get-inventory"),
  openInventoryFile: () => ipcRenderer.invoke("open-inventory-file"),
  getInventoryStatus: () => ipcRenderer.invoke("get-inventory-status"),

  checkAlecaFrame: () => ipcRenderer.invoke("check-alecaframe"),
  loadAlecaFrame: () => ipcRenderer.invoke("load-alecaframe"),
  openAlecaFrameJson: () => ipcRenderer.invoke("open-alecaframe-json"),

  getItemDatabase: () => ipcRenderer.invoke("get-item-database"),
  getWorldState: () => ipcRenderer.invoke("get-world-state"),
  getRelicDatabase: () => ipcRenderer.invoke("get-relic-database"),
  getWfmItems: () => ipcRenderer.invoke("get-wfm-items"),

  wfmSignIn: (creds: unknown) => ipcRenderer.invoke("wfm:signin", creds),
  wfmSignOut: () => ipcRenderer.invoke("wfm:signout"),
  wfmGetSession: () => ipcRenderer.invoke("wfm:session"),
  wfmGetOrders: () => ipcRenderer.invoke("wfm:get-orders"),
  wfmGetContracts: (query?: unknown) => ipcRenderer.invoke("wfm:get-contracts", query),
  wfmCreateOrder: (params: unknown) => ipcRenderer.invoke("wfm:create-order", params),
  wfmUpdateOrder: (orderId: string, updates: unknown) =>
    ipcRenderer.invoke("wfm:update-order", { orderId, updates }),
  wfmDeleteOrder: (orderId: string) => ipcRenderer.invoke("wfm:delete-order", { orderId }),
  wfmSetVisible: (orderIds: string[], visible: boolean) =>
    ipcRenderer.invoke("wfm:set-visible", { orderIds, visible }),
  wfmSearchItems: (query: string, limit?: number) =>
    ipcRenderer.invoke("wfm:search-items", { query, limit }),
  wfmGetMe: () => ipcRenderer.invoke("wfm:get-me"),
  wfmSetStatus: (status: string) => ipcRenderer.invoke("wfm:set-status", { status }),

  getMasteryProgress: () => ipcRenderer.invoke("get-mastery-progress"),
  setDebugMode: (enabled: boolean) => ipcRenderer.invoke("set-debug-mode", !!enabled),
  checkForAppUpdates: () => ipcRenderer.invoke("app:update-check"),
  getAppUpdateState: () => ipcRenderer.invoke("app:update-state"),
  installDownloadedUpdate: () => ipcRenderer.invoke("app:update-install"),

  onInventoryUpdated: (callback: (data: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("inventory-updated", listener);
    return () => {
      ipcRenderer.removeListener("inventory-updated", listener);
    };
  },

  onAppUpdateStatus: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("app-update-status", listener);
    return () => {
      ipcRenderer.removeListener("app-update-status", listener);
    };
  },

  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),

  toggleOverlay: () => ipcRenderer.send("toggle-overlay"),
  simulateRelicTrigger: () => ipcRenderer.send("simulate-relic-trigger"),
  getOverlaySettings: () => ipcRenderer.invoke("overlay:get-settings"),
  setOverlaySettings: (settings: unknown) => ipcRenderer.invoke("overlay:set-settings", settings),
  openOcrCropDebugger: () => ipcRenderer.invoke("overlay:open-crop-debugger"),

  openExternal: (url: string) => ipcRenderer.send("open-external", url),
});
