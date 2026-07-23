import type {
  CreateRivenAuctionPayload,
  IpcEventMap,
  IpcInvokeMap,
  UpdateRivenAuctionPayload,
} from "./ipc.js";
import type { WfmStatus } from "./market.js";

export interface PreloadAPI {
  platform: string;
  getInventory: () => Promise<IpcInvokeMap["getInventory"]["return"]>;
  openInventoryFile: () => Promise<IpcInvokeMap["openInventoryFile"]["return"]>;
  openAlecaFrameInventoryFile: () => Promise<IpcInvokeMap["openAlecaFrameInventoryFile"]["return"]>;
  getInventoryStatus: () => Promise<IpcInvokeMap["getInventoryStatus"]["return"]>;
  getItemDatabase: () => Promise<IpcInvokeMap["getItemDatabase"]["return"]>;
  getWorldState: () => Promise<IpcInvokeMap["getWorldState"]["return"]>;
  getRelicDatabase: () => Promise<IpcInvokeMap["getRelicDatabase"]["return"]>;
  getWfmItems: () => Promise<IpcInvokeMap["getWfmItems"]["return"]>;
  wfmSignIn: (
    creds: IpcInvokeMap["wfmSignIn"]["args"][0],
  ) => Promise<IpcInvokeMap["wfmSignIn"]["return"]>;
  wfmSignOut: () => Promise<IpcInvokeMap["wfmSignOut"]["return"]>;
  wfmGetSession: () => Promise<IpcInvokeMap["wfmGetSession"]["return"]>;
  wfmGetOrders: () => Promise<IpcInvokeMap["wfmGetOrders"]["return"]>;
  wfmGetContracts: (
    query?: IpcInvokeMap["wfmGetContracts"]["args"][0],
  ) => Promise<IpcInvokeMap["wfmGetContracts"]["return"]>;
  wfmSearchItems: (
    query: IpcInvokeMap["wfmSearchItems"]["args"][0],
    limit?: IpcInvokeMap["wfmSearchItems"]["args"][1],
  ) => Promise<IpcInvokeMap["wfmSearchItems"]["return"]>;
  wfmLookupItemBySlug: (
    slug: IpcInvokeMap["wfmLookupItemBySlug"]["args"][0],
  ) => Promise<IpcInvokeMap["wfmLookupItemBySlug"]["return"]>;
  wfmGetMe: () => Promise<IpcInvokeMap["wfmGetMe"]["return"]>;
  getMasteryProgress: () => Promise<IpcInvokeMap["getMasteryProgress"]["return"]>;
  getOverlayPlacementLayout: () => Promise<IpcInvokeMap["getOverlayPlacementLayout"]["return"]>;
  saveOverlayPlacement: (
    ...args: IpcInvokeMap["saveOverlayPlacement"]["args"]
  ) => Promise<IpcInvokeMap["saveOverlayPlacement"]["return"]>;
  saveOverlayScale: (
    ...args: IpcInvokeMap["saveOverlayScale"]["args"]
  ) => Promise<IpcInvokeMap["saveOverlayScale"]["return"]>;
  searchDrops: (
    query: IpcInvokeMap["searchDrops"]["args"][0],
    mode: IpcInvokeMap["searchDrops"]["args"][1],
  ) => Promise<IpcInvokeMap["searchDrops"]["return"]>;
  checkForAppUpdates: () => Promise<IpcInvokeMap["checkForAppUpdates"]["return"]>;
  getAppUpdateState: () => Promise<IpcInvokeMap["getAppUpdateState"]["return"]>;
  downloadAppUpdate: () => Promise<IpcInvokeMap["downloadAppUpdate"]["return"]>;
  installDownloadedUpdate: () => Promise<IpcInvokeMap["installDownloadedUpdate"]["return"]>;
  getAppRuntimeInfo: () => Promise<IpcInvokeMap["getAppRuntimeInfo"]["return"]>;
  openScanDebugFolder: () => Promise<IpcInvokeMap["openScanDebugFolder"]["return"]>;
  openLogFolder: () => Promise<IpcInvokeMap["openLogFolder"]["return"]>;
  onInventoryUpdated: (callback: (data: IpcEventMap["inventory-updated"]) => void) => () => void;
  onItemDbUpdated: (callback: (data: IpcEventMap["item-db-updated"]) => void) => () => void;
  onAppUpdateStatus: (callback: (state: IpcEventMap["app-update-status"]) => void) => () => void;
  onWfmNotification: (
    callback: (notification: IpcEventMap["wfm:notification"]) => void,
  ) => () => void;
  onTradeRecorded: (callback: (data: IpcEventMap["trade-recorded"]) => void) => () => void;
  onWorldStateFetchError: (
    callback: (message: IpcEventMap["world-state-fetch-error"]) => void,
  ) => () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  toggleOverlay: () => void;
  simulateRelicTrigger: () => void;
  updateOverlayTheme: (themeVars: Record<string, string>) => void;
  pushRelicFilters: (filters: { squadSize: number; tierFilter: string | null }) => void;
  getOverlaySettings: () => Promise<IpcInvokeMap["getOverlaySettings"]["return"]>;
  setOverlaySettings: (
    settings: IpcInvokeMap["setOverlaySettings"]["args"][0],
  ) => Promise<IpcInvokeMap["setOverlaySettings"]["return"]>;
  openExternal: (url: string) => void;
  logWarn: (message: string, ...args: unknown[]) => void;
  loadRankedHotset: () => Promise<IpcInvokeMap["loadRankedHotset"]["return"]>;
  saveRankedHotset: (
    data: IpcInvokeMap["saveRankedHotset"]["args"][0],
  ) => Promise<IpcInvokeMap["saveRankedHotset"]["return"]>;
  loadSnapshotCache: () => Promise<IpcInvokeMap["loadSnapshotCache"]["return"]>;
  saveSnapshotCache: (
    data: IpcInvokeMap["saveSnapshotCache"]["args"][0],
  ) => Promise<IpcInvokeMap["saveSnapshotCache"]["return"]>;
  getStatsHistory: () => Promise<IpcInvokeMap["getStatsHistory"]["return"]>;
  getStatsCurrentSession: () => Promise<IpcInvokeMap["getStatsCurrentSession"]["return"]>;
  importStatsHistory: (raw: unknown[]) => Promise<IpcInvokeMap["importStatsHistory"]["return"]>;
  getTradeLog: () => Promise<IpcInvokeMap["getTradeLog"]["return"]>;
  importTradeLog: (
    events: IpcInvokeMap["importTradeLog"]["args"][0],
  ) => Promise<IpcInvokeMap["importTradeLog"]["return"]>;
  getHelperStatus: () => Promise<IpcInvokeMap["getHelperStatus"]["return"]>;
  runHelperNow: () => Promise<IpcInvokeMap["runHelperNow"]["return"]>;
  downloadHelper: () => Promise<IpcInvokeMap["downloadHelper"]["return"]>;
  getRivens: () => Promise<IpcInvokeMap["getRivens"]["return"]>;
  getRivenWeaponNames: () => Promise<IpcInvokeMap["getRivenWeaponNames"]["return"]>;
  getRivenStatOptions: () => Promise<IpcInvokeMap["getRivenStatOptions"]["return"]>;
  searchRivenAuctions: (
    weaponName: string,
    positiveWfmNames: string[],
    negativeWfmNames: string[],
  ) => Promise<IpcInvokeMap["searchRivenAuctions"]["return"]>;
  getRivenBestAttributes: (
    weaponName: string,
  ) => Promise<IpcInvokeMap["getRivenBestAttributes"]["return"]>;
  onHelperDownloadProgress: (
    callback: (progress: IpcEventMap["helper-download-progress"]) => void,
  ) => () => void;
  getArbiRuns: () => Promise<IpcInvokeMap["getArbiRuns"]["return"]>;
  setArbiRunVitus: (
    id: IpcInvokeMap["setArbiRunVitus"]["args"][0],
    vitus: IpcInvokeMap["setArbiRunVitus"]["args"][1],
  ) => Promise<IpcInvokeMap["setArbiRunVitus"]["return"]>;
  deleteArbiRun: (
    id: IpcInvokeMap["deleteArbiRun"]["args"][0],
  ) => Promise<IpcInvokeMap["deleteArbiRun"]["return"]>;
  deleteArbiRunLog: (
    id: IpcInvokeMap["deleteArbiRunLog"]["args"][0],
  ) => Promise<IpcInvokeMap["deleteArbiRunLog"]["return"]>;
  exportArbiRunLog: (
    id: IpcInvokeMap["exportArbiRunLog"]["args"][0],
  ) => Promise<IpcInvokeMap["exportArbiRunLog"]["return"]>;
  importArbiLog: () => Promise<IpcInvokeMap["importArbiLog"]["return"]>;
  saveArbiRunImage: (
    id: IpcInvokeMap["saveArbiRunImage"]["args"][0],
    png: IpcInvokeMap["saveArbiRunImage"]["args"][1],
  ) => Promise<IpcInvokeMap["saveArbiRunImage"]["return"]>;
  showArbiRunLogInFolder: (
    id: IpcInvokeMap["showArbiRunLogInFolder"]["args"][0],
  ) => Promise<IpcInvokeMap["showArbiRunLogInFolder"]["return"]>;
  onArbiRunSaved: (callback: (run: IpcEventMap["arbi-run-saved"]) => void) => () => void;
  onArbiOpenRun: (callback: (runId: IpcEventMap["arbi-open-run"]) => void) => () => void;
  getArbiSchedule: () => Promise<IpcInvokeMap["getArbiSchedule"]["return"]>;
  setArbiScheduleOccurrence: (
    key: IpcInvokeMap["setArbiScheduleOccurrence"]["args"][0],
    enabled: IpcInvokeMap["setArbiScheduleOccurrence"]["args"][1],
  ) => Promise<IpcInvokeMap["setArbiScheduleOccurrence"]["return"]>;
  setArbiScheduleFavorite: (
    nodeId: IpcInvokeMap["setArbiScheduleFavorite"]["args"][0],
    enabled: IpcInvokeMap["setArbiScheduleFavorite"]["args"][1],
  ) => Promise<IpcInvokeMap["setArbiScheduleFavorite"]["return"]>;
  setArbiScheduleLead: (
    minutes: IpcInvokeMap["setArbiScheduleLead"]["args"][0],
  ) => Promise<IpcInvokeMap["setArbiScheduleLead"]["return"]>;
}

export interface TradePreloadAPI {
  wfmCreateOrder: (
    params: IpcInvokeMap["wfmCreateOrder"]["args"][0],
  ) => Promise<IpcInvokeMap["wfmCreateOrder"]["return"]>;
  wfmUpdateOrder: (
    orderId: IpcInvokeMap["wfmUpdateOrder"]["args"][0],
    updates: IpcInvokeMap["wfmUpdateOrder"]["args"][1],
  ) => Promise<IpcInvokeMap["wfmUpdateOrder"]["return"]>;
  wfmDeleteOrder: (
    orderId: IpcInvokeMap["wfmDeleteOrder"]["args"][0],
  ) => Promise<IpcInvokeMap["wfmDeleteOrder"]["return"]>;
  wfmSetVisible: (
    orderIds: IpcInvokeMap["wfmSetVisible"]["args"][0],
    visible: IpcInvokeMap["wfmSetVisible"]["args"][1],
  ) => Promise<IpcInvokeMap["wfmSetVisible"]["return"]>;
  wfmSetStatus: (status: WfmStatus) => Promise<IpcInvokeMap["wfmSetStatus"]["return"]>;
  createRivenAuction: (
    payload: CreateRivenAuctionPayload,
  ) => Promise<IpcInvokeMap["createRivenAuction"]["return"]>;
  updateRivenAuction: (
    payload: UpdateRivenAuctionPayload,
  ) => Promise<IpcInvokeMap["updateRivenAuction"]["return"]>;
}
