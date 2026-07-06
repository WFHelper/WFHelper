import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateRivenAuctionPayload,
  UpdateRivenAuctionPayload,
} from "./config/shared/rivenTypes";
import { ipcDataBridge } from "./ipc/preloadListeners";
import {
  INVENTORY_GET,
  INVENTORY_OPEN_FILE,
  INVENTORY_OPEN_ALECA_FRAME_FILE,
  INVENTORY_GET_STATUS,
  INVENTORY_UPDATED,
  DB_GET_ITEM_DATABASE,
  DB_GET_WORLD_STATE,
  DB_GET_RELIC_DATABASE,
  DROP_SEARCH,
  DB_GET_WFM_ITEMS,
  DB_GET_MASTERY,
  WFM_SIGNIN,
  WFM_SIGNOUT,
  WFM_SESSION,
  WFM_GET_ORDERS,
  WFM_GET_CONTRACTS,
  WFM_CREATE_ORDER,
  WFM_UPDATE_ORDER,
  WFM_DELETE_ORDER,
  WFM_SET_VISIBLE,
  WFM_SEARCH_ITEMS,
  WFM_LOOKUP_ITEM,
  WFM_GET_ME,
  WFM_SET_STATUS,
  WFM_NOTIFICATION,
  APP_UPDATE_CHECK,
  APP_UPDATE_STATE,
  APP_UPDATE_DOWNLOAD,
  APP_UPDATE_INSTALL,
  APP_UPDATE_STATUS,
  APP_RUNTIME_INFO,
  WINDOW_MINIMIZE,
  WINDOW_MAXIMIZE,
  WINDOW_CLOSE,
  TOGGLE_OVERLAY,
  SIMULATE_RELIC_TRIGGER,
  OVERLAY_THEME_UPDATED,
  OVERLAY_PUSH_RELIC_FILTERS,
  OVERLAY_GET_SETTINGS,
  OVERLAY_SET_SETTINGS,
  OPEN_EXTERNAL,
  LOG_WARN,
  RANKED_HOTSET_LOAD,
  RANKED_HOTSET_SAVE,
  SNAPSHOT_CACHE_LOAD,
  SNAPSHOT_CACHE_SAVE,
  STATS_GET_HISTORY,
  STATS_GET_CURRENT,
  STATS_IMPORT,
  STATS_GET_TRADES,
  STATS_IMPORT_TRADES,
  TRADE_RECORDED,
  HELPER_GET_STATUS,
  HELPER_RUN_NOW,
  HELPER_DOWNLOAD,
  HELPER_DOWNLOAD_PROGRESS,
  RIVENS_GET,
  RIVENS_GET_WEAPON_NAMES,
  RIVENS_GET_STAT_OPTIONS,
  RIVENS_SEARCH_AUCTIONS,
  RIVENS_GET_BEST_ATTRIBUTES,
  RIVENS_CREATE_AUCTION,
  RIVENS_UPDATE_AUCTION,
  WORLD_STATE_FETCH_ERROR,
  ARBI_GET_RUNS,
  ARBI_SET_VITUS,
  ARBI_DELETE_RUN,
  ARBI_DELETE_LOG,
  ARBI_EXPORT_LOG,
  ARBI_IMPORT_LOG,
  ARBI_SAVE_IMAGE,
  ARBI_SHOW_LOG_IN_FOLDER,
  ARBI_RUN_SAVED,
} from "./config/shared/ipcChannels";

try {
  contextBridge.exposeInMainWorld("api", {
    getInventory: () => ipcRenderer.invoke(INVENTORY_GET),
    openInventoryFile: () => ipcRenderer.invoke(INVENTORY_OPEN_FILE),
    openAlecaFrameInventoryFile: () => ipcRenderer.invoke(INVENTORY_OPEN_ALECA_FRAME_FILE),
    getInventoryStatus: () => ipcRenderer.invoke(INVENTORY_GET_STATUS),

    getItemDatabase: () => ipcRenderer.invoke(DB_GET_ITEM_DATABASE),
    getWorldState: () => ipcRenderer.invoke(DB_GET_WORLD_STATE),
    getRelicDatabase: () => ipcRenderer.invoke(DB_GET_RELIC_DATABASE),
    getWfmItems: () => ipcRenderer.invoke(DB_GET_WFM_ITEMS),

    wfmSignIn: (creds: unknown) => ipcRenderer.invoke(WFM_SIGNIN, creds),
    wfmSignOut: () => ipcRenderer.invoke(WFM_SIGNOUT),
    wfmGetSession: () => ipcRenderer.invoke(WFM_SESSION),
    wfmGetOrders: () => ipcRenderer.invoke(WFM_GET_ORDERS),
    wfmGetContracts: (query?: unknown) => ipcRenderer.invoke(WFM_GET_CONTRACTS, query),
    wfmSearchItems: (query: string, limit?: number) =>
      ipcRenderer.invoke(WFM_SEARCH_ITEMS, { query, limit }),
    wfmLookupItemBySlug: (slug: string) => ipcRenderer.invoke(WFM_LOOKUP_ITEM, { slug }),
    wfmGetMe: () => ipcRenderer.invoke(WFM_GET_ME),

    getMasteryProgress: () => ipcRenderer.invoke(DB_GET_MASTERY),
    searchDrops: (query: string, mode: string) =>
      ipcRenderer.invoke(DROP_SEARCH, { query, mode }),
    checkForAppUpdates: () => ipcRenderer.invoke(APP_UPDATE_CHECK),
    getAppUpdateState: () => ipcRenderer.invoke(APP_UPDATE_STATE),
    downloadAppUpdate: () => ipcRenderer.invoke(APP_UPDATE_DOWNLOAD),
    installDownloadedUpdate: () => ipcRenderer.invoke(APP_UPDATE_INSTALL),
    getAppRuntimeInfo: () => ipcRenderer.invoke(APP_RUNTIME_INFO),

    onInventoryUpdated: ipcDataBridge<unknown>(ipcRenderer, INVENTORY_UPDATED),
    onAppUpdateStatus: ipcDataBridge<unknown>(ipcRenderer, APP_UPDATE_STATUS),
    onWfmNotification: ipcDataBridge<unknown>(ipcRenderer, WFM_NOTIFICATION),
    onTradeRecorded: ipcDataBridge<unknown>(ipcRenderer, TRADE_RECORDED),
    onWorldStateFetchError: ipcDataBridge<unknown>(ipcRenderer, WORLD_STATE_FETCH_ERROR),

    minimizeWindow: () => ipcRenderer.send(WINDOW_MINIMIZE),
    maximizeWindow: () => ipcRenderer.send(WINDOW_MAXIMIZE),
    closeWindow: () => ipcRenderer.send(WINDOW_CLOSE),

    toggleOverlay: () => ipcRenderer.send(TOGGLE_OVERLAY),
    simulateRelicTrigger: () => ipcRenderer.send(SIMULATE_RELIC_TRIGGER),
    updateOverlayTheme: (themeVars: unknown) => ipcRenderer.send(OVERLAY_THEME_UPDATED, themeVars),
    pushRelicFilters: (filters: unknown) => ipcRenderer.send(OVERLAY_PUSH_RELIC_FILTERS, filters),
    getOverlaySettings: () => ipcRenderer.invoke(OVERLAY_GET_SETTINGS),
    setOverlaySettings: (settings: unknown) => ipcRenderer.invoke(OVERLAY_SET_SETTINGS, settings),

    openExternal: (url: string) => ipcRenderer.send(OPEN_EXTERNAL, url),
    logWarn: (message: string, ...args: unknown[]) => ipcRenderer.send(LOG_WARN, message, ...args),

    loadRankedHotset: () => ipcRenderer.invoke(RANKED_HOTSET_LOAD),
    saveRankedHotset: (data: unknown) => ipcRenderer.invoke(RANKED_HOTSET_SAVE, data),
    loadSnapshotCache: () => ipcRenderer.invoke(SNAPSHOT_CACHE_LOAD),
    saveSnapshotCache: (data: unknown) => ipcRenderer.invoke(SNAPSHOT_CACHE_SAVE, data),

    getStatsHistory: () => ipcRenderer.invoke(STATS_GET_HISTORY),
    getStatsCurrentSession: () => ipcRenderer.invoke(STATS_GET_CURRENT),
    importStatsHistory: (raw: unknown[]) => ipcRenderer.invoke(STATS_IMPORT, raw),
    getTradeLog: () => ipcRenderer.invoke(STATS_GET_TRADES),
    importTradeLog: (events: unknown[]) => ipcRenderer.invoke(STATS_IMPORT_TRADES, events),

    getHelperStatus: () => ipcRenderer.invoke(HELPER_GET_STATUS),
    runHelperNow: () => ipcRenderer.invoke(HELPER_RUN_NOW),
    downloadHelper: () => ipcRenderer.invoke(HELPER_DOWNLOAD),
    getRivens: () => ipcRenderer.invoke(RIVENS_GET),
    getRivenWeaponNames: () => ipcRenderer.invoke(RIVENS_GET_WEAPON_NAMES),
    getRivenStatOptions: () => ipcRenderer.invoke(RIVENS_GET_STAT_OPTIONS),
    searchRivenAuctions: (
      weaponName: string,
      positiveWfmNames: string[],
      negativeWfmNames: string[],
    ) => ipcRenderer.invoke(RIVENS_SEARCH_AUCTIONS, weaponName, positiveWfmNames, negativeWfmNames),
    getRivenBestAttributes: (weaponName: string) =>
      ipcRenderer.invoke(RIVENS_GET_BEST_ATTRIBUTES, weaponName),
    onHelperDownloadProgress: ipcDataBridge<unknown>(ipcRenderer, HELPER_DOWNLOAD_PROGRESS),

    getArbiRuns: () => ipcRenderer.invoke(ARBI_GET_RUNS),
    setArbiRunVitus: (id: string, vitus: number | null) =>
      ipcRenderer.invoke(ARBI_SET_VITUS, id, vitus),
    deleteArbiRun: (id: string) => ipcRenderer.invoke(ARBI_DELETE_RUN, id),
    deleteArbiRunLog: (id: string) => ipcRenderer.invoke(ARBI_DELETE_LOG, id),
    exportArbiRunLog: (id: string) => ipcRenderer.invoke(ARBI_EXPORT_LOG, id),
    importArbiLog: () => ipcRenderer.invoke(ARBI_IMPORT_LOG),
    saveArbiRunImage: (id: string, png: Uint8Array) =>
      ipcRenderer.invoke(ARBI_SAVE_IMAGE, id, png),
    showArbiRunLogInFolder: (id: string) => ipcRenderer.invoke(ARBI_SHOW_LOG_IN_FOLDER, id),
    onArbiRunSaved: ipcDataBridge<unknown>(ipcRenderer, ARBI_RUN_SAVED),
  });

  contextBridge.exposeInMainWorld("tradeApi", {
    wfmCreateOrder: (params: unknown) => ipcRenderer.invoke(WFM_CREATE_ORDER, params),
    wfmUpdateOrder: (orderId: string, updates: unknown) =>
      ipcRenderer.invoke(WFM_UPDATE_ORDER, { orderId, updates }),
    wfmDeleteOrder: (orderId: string) => ipcRenderer.invoke(WFM_DELETE_ORDER, { orderId }),
    wfmSetVisible: (orderIds: string[], visible: boolean) =>
      ipcRenderer.invoke(WFM_SET_VISIBLE, { orderIds, visible }),
    wfmSetStatus: (status: string) => ipcRenderer.invoke(WFM_SET_STATUS, { status }),
    createRivenAuction: (payload: CreateRivenAuctionPayload) =>
      ipcRenderer.invoke(RIVENS_CREATE_AUCTION, payload),
    updateRivenAuction: (payload: UpdateRivenAuctionPayload) =>
      ipcRenderer.invoke(RIVENS_UPDATE_AUCTION, payload),
  });
} catch (err) {
  console.error("[Preload] FATAL: contextBridge.exposeInMainWorld failed:", err);
}
