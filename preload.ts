import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getInventory: () => ipcRenderer.invoke("get-inventory"),
  openInventoryFile: () => ipcRenderer.invoke("open-inventory-file"),
  getInventoryStatus: () => ipcRenderer.invoke("get-inventory-status"),

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
  wfmLookupItemBySlug: (slug: string) => ipcRenderer.invoke("wfm:lookup-item-by-slug", { slug }),
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

  onWfmNotification: (callback: (notification: unknown) => void) => {
    const listener = (_event: unknown, notification: unknown) => callback(notification);
    ipcRenderer.on("wfm:notification", listener);
    return () => {
      ipcRenderer.removeListener("wfm:notification", listener);
    };
  },

  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),

  toggleOverlay: () => ipcRenderer.send("toggle-overlay"),
  simulateRelicTrigger: () => ipcRenderer.send("simulate-relic-trigger"),
  updateOverlayTheme: (themeVars: unknown) => ipcRenderer.send("overlay-theme-updated", themeVars),
  pushRelicFilters: (filters: unknown) => ipcRenderer.send("overlay:push-relic-filters", filters),
  getOverlaySettings: () => ipcRenderer.invoke("overlay:get-settings"),
  setOverlaySettings: (settings: unknown) => ipcRenderer.invoke("overlay:set-settings", settings),
  openOcrCropDebugger: () => ipcRenderer.invoke("overlay:open-crop-debugger"),

  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  logWarn: (message: string, ...args: unknown[]) => ipcRenderer.send("log:warn", message, ...args),

  loadRankedHotset: () => ipcRenderer.invoke("ranked-hotset:load"),
  saveRankedHotset: (data: unknown) => ipcRenderer.invoke("ranked-hotset:save", data),
  loadSnapshotCache: () => ipcRenderer.invoke("snapshot-cache:load"),
  saveSnapshotCache: (data: unknown) => ipcRenderer.invoke("snapshot-cache:save", data),

  getStatsHistory: () => ipcRenderer.invoke("stats:get-history"),
  getStatsCurrentSession: () => ipcRenderer.invoke("stats:get-current"),
  importStatsHistory: (raw: unknown[]) => ipcRenderer.invoke("stats:import", raw),
  getTradeLog: () => ipcRenderer.invoke("stats:get-trades"),
  importTradeLog: (events: unknown[]) => ipcRenderer.invoke("stats:import-trades", events),

  getHelperStatus: () => ipcRenderer.invoke("helper:get-status"),
  runHelperNow: () => ipcRenderer.invoke("helper:run-now"),
  downloadHelper: () => ipcRenderer.invoke("helper:download"),
  getRivens: () => ipcRenderer.invoke("get-rivens"),
  searchSimilarRivens: (weaponName: string, positiveStats: string[], negativeStats: string[]) =>
    ipcRenderer.invoke("search-similar-rivens", weaponName, positiveStats, negativeStats),
  onHelperDownloadProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on("helper-download-progress", listener);
    return () => {
      ipcRenderer.removeListener("helper-download-progress", listener);
    };
  },
});
