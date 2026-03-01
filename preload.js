const { contextBridge, ipcRenderer } = require("electron");

// Expose a safe API to the renderer process.
// The renderer can ONLY call these methods — no direct Node.js access.
contextBridge.exposeInMainWorld("api", {
  // Inventory
  getInventory: () => ipcRenderer.invoke("get-inventory"),
  openInventoryFile: () => ipcRenderer.invoke("open-inventory-file"),
  getInventoryStatus: () => ipcRenderer.invoke("get-inventory-status"),

  // AlecaFrame
  checkAlecaFrame: () => ipcRenderer.invoke("check-alecaframe"),
  loadAlecaFrame: () => ipcRenderer.invoke("load-alecaframe"),
  openAlecaFrameJson: () => ipcRenderer.invoke("open-alecaframe-json"),

  // Item Database
  getItemDatabase: () => ipcRenderer.invoke("get-item-database"),

  // World State
  getWorldState: () => ipcRenderer.invoke("get-world-state"),

  // Relic Database
  getRelicDatabase: () => ipcRenderer.invoke("get-relic-database"),

  // Warframe.market (public item list used for trade links)
  getWfmItems: () => ipcRenderer.invoke("get-wfm-items"),

  // Warframe.market authenticated integration
  wfmSignIn:     (creds)              => ipcRenderer.invoke("wfm:signin",        creds),
  wfmSignOut:    ()                   => ipcRenderer.invoke("wfm:signout"),
  wfmGetSession: ()                   => ipcRenderer.invoke("wfm:session"),
  wfmGetOrders:  ()                   => ipcRenderer.invoke("wfm:get-orders"),
  wfmCreateOrder:(params)             => ipcRenderer.invoke("wfm:create-order",  params),
  wfmUpdateOrder:(orderId, updates)   => ipcRenderer.invoke("wfm:update-order",  { orderId, updates }),
  wfmDeleteOrder:(orderId)            => ipcRenderer.invoke("wfm:delete-order",  { orderId }),
  wfmSetVisible: (orderIds, visible)  => ipcRenderer.invoke("wfm:set-visible",   { orderIds, visible }),
  wfmSearchItems:(query, limit)       => ipcRenderer.invoke("wfm:search-items",  { query, limit }),
  wfmGetMe:      ()                   => ipcRenderer.invoke("wfm:get-me"),
  wfmSetStatus:  (status)             => ipcRenderer.invoke("wfm:set-status",    { status }),

  // Mastery Helper
  getMasteryProgress: () => ipcRenderer.invoke("get-mastery-progress"),
  setDebugMode: (enabled) => ipcRenderer.invoke("set-debug-mode", !!enabled),

  // Listen for live inventory updates (file watcher)
  onInventoryUpdated: (callback) => {
    ipcRenderer.on("inventory-updated", (_event, data) => callback(data));
  },

  // Window controls (custom titlebar)
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),

  // Relic reward overlay
  toggleOverlay: () => ipcRenderer.send("toggle-overlay"),
  simulateRelicTrigger: () => ipcRenderer.send("simulate-relic-trigger"),
  getOverlaySettings: () => ipcRenderer.invoke("overlay:get-settings"),
  setOverlaySettings: (settings) => ipcRenderer.invoke("overlay:set-settings", settings),

  // External links
  openExternal: (url) => ipcRenderer.send("open-external", url),
});
