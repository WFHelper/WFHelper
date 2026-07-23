import { contextBridge, ipcRenderer } from "electron";
import type { IpcEventMap, IpcInvokeMap } from "./src/types/ipc";
import type { PreloadAPI, TradePreloadAPI } from "./src/types/preload";
import { ipcDataBridge } from "./ipc/preloadListeners";
import {
  INVENTORY_GET,
  INVENTORY_OPEN_FILE,
  INVENTORY_OPEN_ALECA_FRAME_FILE,
  INVENTORY_GET_STATUS,
  INVENTORY_UPDATED,
  DB_GET_ITEM_DATABASE,
  ITEM_DB_UPDATED,
  DB_GET_WORLD_STATE,
  DB_GET_RELIC_DATABASE,
  DROP_SEARCH,
  DB_GET_WFM_ITEMS,
  DB_GET_MASTERY,
  OVERLAY_PLACEMENT_LAYOUT,
  OVERLAY_SAVE_PLACEMENT,
  OVERLAY_SAVE_SCALE,
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
  SCAN_DEBUG_OPEN_FOLDER,
  LOGS_OPEN_FOLDER,
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
  ARBI_OPEN_RUN,
  ARBI_SCHED_GET,
  ARBI_SCHED_SET_OCCURRENCE,
  ARBI_SCHED_SET_FAVORITE,
  ARBI_SCHED_SET_LEAD,
} from "./config/shared/ipcChannels";

// invoke() is typed any; this wrapper pins each call's args+return to its IpcInvokeMap entry so drift fails typecheck.
const inv =
  <K extends keyof IpcInvokeMap>(channel: string) =>
  (...args: IpcInvokeMap[K]["args"]): Promise<IpcInvokeMap[K]["return"]> =>
    ipcRenderer.invoke(channel, ...args);

// Methods whose wire payload wraps the args in an object.
type Ret<K extends keyof IpcInvokeMap> = Promise<IpcInvokeMap[K]["return"]>;

try {
  contextBridge.exposeInMainWorld("api", {
    platform: process.platform,

    getInventory: inv<"getInventory">(INVENTORY_GET),
    openInventoryFile: inv<"openInventoryFile">(INVENTORY_OPEN_FILE),
    openAlecaFrameInventoryFile: inv<"openAlecaFrameInventoryFile">(
      INVENTORY_OPEN_ALECA_FRAME_FILE,
    ),
    getInventoryStatus: inv<"getInventoryStatus">(INVENTORY_GET_STATUS),

    getItemDatabase: inv<"getItemDatabase">(DB_GET_ITEM_DATABASE),
    getWorldState: inv<"getWorldState">(DB_GET_WORLD_STATE),
    getRelicDatabase: inv<"getRelicDatabase">(DB_GET_RELIC_DATABASE),
    getWfmItems: inv<"getWfmItems">(DB_GET_WFM_ITEMS),

    wfmSignIn: inv<"wfmSignIn">(WFM_SIGNIN),
    wfmSignOut: inv<"wfmSignOut">(WFM_SIGNOUT),
    wfmGetSession: inv<"wfmGetSession">(WFM_SESSION),
    wfmGetOrders: inv<"wfmGetOrders">(WFM_GET_ORDERS),
    wfmGetContracts: inv<"wfmGetContracts">(WFM_GET_CONTRACTS),
    wfmSearchItems: (query, limit): Ret<"wfmSearchItems"> =>
      ipcRenderer.invoke(WFM_SEARCH_ITEMS, { query, limit }),
    wfmLookupItemBySlug: (slug): Ret<"wfmLookupItemBySlug"> =>
      ipcRenderer.invoke(WFM_LOOKUP_ITEM, { slug }),
    wfmGetMe: inv<"wfmGetMe">(WFM_GET_ME),

    getMasteryProgress: inv<"getMasteryProgress">(DB_GET_MASTERY),
    getOverlayPlacementLayout: inv<"getOverlayPlacementLayout">(OVERLAY_PLACEMENT_LAYOUT),
    saveOverlayPlacement: inv<"saveOverlayPlacement">(OVERLAY_SAVE_PLACEMENT),
    saveOverlayScale: inv<"saveOverlayScale">(OVERLAY_SAVE_SCALE),
    searchDrops: (query, mode): Ret<"searchDrops"> =>
      ipcRenderer.invoke(DROP_SEARCH, { query, mode }),
    checkForAppUpdates: inv<"checkForAppUpdates">(APP_UPDATE_CHECK),
    getAppUpdateState: inv<"getAppUpdateState">(APP_UPDATE_STATE),
    downloadAppUpdate: inv<"downloadAppUpdate">(APP_UPDATE_DOWNLOAD),
    installDownloadedUpdate: inv<"installDownloadedUpdate">(APP_UPDATE_INSTALL),
    getAppRuntimeInfo: inv<"getAppRuntimeInfo">(APP_RUNTIME_INFO),
    openScanDebugFolder: inv<"openScanDebugFolder">(SCAN_DEBUG_OPEN_FOLDER),
    openLogFolder: inv<"openLogFolder">(LOGS_OPEN_FOLDER),

    onInventoryUpdated: ipcDataBridge<IpcEventMap["inventory-updated"]>(
      ipcRenderer,
      INVENTORY_UPDATED,
    ),
    onItemDbUpdated: ipcDataBridge<IpcEventMap["item-db-updated"]>(ipcRenderer, ITEM_DB_UPDATED),
    onAppUpdateStatus: ipcDataBridge<IpcEventMap["app-update-status"]>(
      ipcRenderer,
      APP_UPDATE_STATUS,
    ),
    onWfmNotification: ipcDataBridge<IpcEventMap["wfm:notification"]>(
      ipcRenderer,
      WFM_NOTIFICATION,
    ),
    onTradeRecorded: ipcDataBridge<IpcEventMap["trade-recorded"]>(ipcRenderer, TRADE_RECORDED),
    onWorldStateFetchError: ipcDataBridge<IpcEventMap["world-state-fetch-error"]>(
      ipcRenderer,
      WORLD_STATE_FETCH_ERROR,
    ),

    minimizeWindow: () => ipcRenderer.send(WINDOW_MINIMIZE),
    maximizeWindow: () => ipcRenderer.send(WINDOW_MAXIMIZE),
    closeWindow: () => ipcRenderer.send(WINDOW_CLOSE),

    toggleOverlay: () => ipcRenderer.send(TOGGLE_OVERLAY),
    simulateRelicTrigger: () => ipcRenderer.send(SIMULATE_RELIC_TRIGGER),
    updateOverlayTheme: (themeVars) => ipcRenderer.send(OVERLAY_THEME_UPDATED, themeVars),
    pushRelicFilters: (filters) => ipcRenderer.send(OVERLAY_PUSH_RELIC_FILTERS, filters),
    getOverlaySettings: inv<"getOverlaySettings">(OVERLAY_GET_SETTINGS),
    setOverlaySettings: inv<"setOverlaySettings">(OVERLAY_SET_SETTINGS),

    openExternal: (url) => ipcRenderer.send(OPEN_EXTERNAL, url),
    logWarn: (message, ...args) => ipcRenderer.send(LOG_WARN, message, ...args),

    loadRankedHotset: inv<"loadRankedHotset">(RANKED_HOTSET_LOAD),
    saveRankedHotset: inv<"saveRankedHotset">(RANKED_HOTSET_SAVE),
    loadSnapshotCache: inv<"loadSnapshotCache">(SNAPSHOT_CACHE_LOAD),
    saveSnapshotCache: inv<"saveSnapshotCache">(SNAPSHOT_CACHE_SAVE),

    getStatsHistory: inv<"getStatsHistory">(STATS_GET_HISTORY),
    getStatsCurrentSession: inv<"getStatsCurrentSession">(STATS_GET_CURRENT),
    importStatsHistory: inv<"importStatsHistory">(STATS_IMPORT),
    getTradeLog: inv<"getTradeLog">(STATS_GET_TRADES),
    importTradeLog: inv<"importTradeLog">(STATS_IMPORT_TRADES),

    getHelperStatus: inv<"getHelperStatus">(HELPER_GET_STATUS),
    runHelperNow: inv<"runHelperNow">(HELPER_RUN_NOW),
    downloadHelper: inv<"downloadHelper">(HELPER_DOWNLOAD),
    getRivens: inv<"getRivens">(RIVENS_GET),
    getRivenWeaponNames: inv<"getRivenWeaponNames">(RIVENS_GET_WEAPON_NAMES),
    getRivenStatOptions: inv<"getRivenStatOptions">(RIVENS_GET_STAT_OPTIONS),
    searchRivenAuctions: inv<"searchRivenAuctions">(RIVENS_SEARCH_AUCTIONS),
    getRivenBestAttributes: inv<"getRivenBestAttributes">(RIVENS_GET_BEST_ATTRIBUTES),
    onHelperDownloadProgress: ipcDataBridge<IpcEventMap["helper-download-progress"]>(
      ipcRenderer,
      HELPER_DOWNLOAD_PROGRESS,
    ),

    getArbiRuns: inv<"getArbiRuns">(ARBI_GET_RUNS),
    setArbiRunVitus: inv<"setArbiRunVitus">(ARBI_SET_VITUS),
    deleteArbiRun: inv<"deleteArbiRun">(ARBI_DELETE_RUN),
    deleteArbiRunLog: inv<"deleteArbiRunLog">(ARBI_DELETE_LOG),
    exportArbiRunLog: inv<"exportArbiRunLog">(ARBI_EXPORT_LOG),
    importArbiLog: inv<"importArbiLog">(ARBI_IMPORT_LOG),
    saveArbiRunImage: inv<"saveArbiRunImage">(ARBI_SAVE_IMAGE),
    showArbiRunLogInFolder: inv<"showArbiRunLogInFolder">(ARBI_SHOW_LOG_IN_FOLDER),
    onArbiRunSaved: ipcDataBridge<IpcEventMap["arbi-run-saved"]>(ipcRenderer, ARBI_RUN_SAVED),
    onArbiOpenRun: ipcDataBridge<IpcEventMap["arbi-open-run"]>(ipcRenderer, ARBI_OPEN_RUN),

    getArbiSchedule: inv<"getArbiSchedule">(ARBI_SCHED_GET),
    setArbiScheduleOccurrence: inv<"setArbiScheduleOccurrence">(ARBI_SCHED_SET_OCCURRENCE),
    setArbiScheduleFavorite: inv<"setArbiScheduleFavorite">(ARBI_SCHED_SET_FAVORITE),
    setArbiScheduleLead: inv<"setArbiScheduleLead">(ARBI_SCHED_SET_LEAD),
  } satisfies PreloadAPI);

  contextBridge.exposeInMainWorld("tradeApi", {
    wfmCreateOrder: inv<"wfmCreateOrder">(WFM_CREATE_ORDER),
    wfmUpdateOrder: (orderId, updates): Ret<"wfmUpdateOrder"> =>
      ipcRenderer.invoke(WFM_UPDATE_ORDER, { orderId, updates }),
    wfmDeleteOrder: (orderId): Ret<"wfmDeleteOrder"> =>
      ipcRenderer.invoke(WFM_DELETE_ORDER, { orderId }),
    wfmSetVisible: (orderIds, visible): Ret<"wfmSetVisible"> =>
      ipcRenderer.invoke(WFM_SET_VISIBLE, { orderIds, visible }),
    wfmSetStatus: (status): Ret<"wfmSetStatus"> => ipcRenderer.invoke(WFM_SET_STATUS, { status }),
    createRivenAuction: inv<"createRivenAuction">(RIVENS_CREATE_AUCTION),
    updateRivenAuction: inv<"updateRivenAuction">(RIVENS_UPDATE_AUCTION),
  } satisfies TradePreloadAPI);
} catch (err) {
  console.error("[Preload] FATAL: contextBridge.exposeInMainWorld failed:", err);
}
