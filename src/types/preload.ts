import type { IpcEventMap, IpcInvokeMap } from "./ipc.js";
import type { WfmStatus } from "./market.js";

export interface PreloadAPI {
  getInventory: () => Promise<IpcInvokeMap["getInventory"]["return"]>;
  openInventoryFile: () => Promise<IpcInvokeMap["openInventoryFile"]["return"]>;
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
  wfmSearchItems: (
    query: IpcInvokeMap["wfmSearchItems"]["args"][0],
    limit?: IpcInvokeMap["wfmSearchItems"]["args"][1],
  ) => Promise<IpcInvokeMap["wfmSearchItems"]["return"]>;
  wfmLookupItemBySlug: (
    slug: IpcInvokeMap["wfmLookupItemBySlug"]["args"][0],
  ) => Promise<IpcInvokeMap["wfmLookupItemBySlug"]["return"]>;
  wfmGetMe: () => Promise<IpcInvokeMap["wfmGetMe"]["return"]>;
  wfmSetStatus: (status: WfmStatus) => Promise<IpcInvokeMap["wfmSetStatus"]["return"]>;
  getMasteryProgress: () => Promise<IpcInvokeMap["getMasteryProgress"]["return"]>;
  setDebugMode: (
    enabled: IpcInvokeMap["setDebugMode"]["args"][0],
  ) => Promise<IpcInvokeMap["setDebugMode"]["return"]>;
  checkForAppUpdates: () => Promise<IpcInvokeMap["checkForAppUpdates"]["return"]>;
  getAppUpdateState: () => Promise<IpcInvokeMap["getAppUpdateState"]["return"]>;
  installDownloadedUpdate: () => Promise<IpcInvokeMap["installDownloadedUpdate"]["return"]>;
  onInventoryUpdated: (callback: (data: IpcEventMap["inventory-updated"]) => void) => () => void;
  onAppUpdateStatus: (callback: (state: IpcEventMap["app-update-status"]) => void) => () => void;
  onWfmNotification: (
    callback: (notification: IpcEventMap["wfm:notification"]) => void,
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
  openOcrCropDebugger: () => Promise<IpcInvokeMap["openOcrCropDebugger"]["return"]>;
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
  getWeaponRivenType: (weaponName: string) => Promise<IpcInvokeMap["getWeaponRivenType"]["return"]>;
  createRivenAuction: (
    weaponName: string,
    rivenName: string,
    stats: { tag: string; value: number; positive: boolean; multiplier?: boolean }[],
    rerolls: number,
    masteryReq: number,
    polarity: string,
    modRank: number,
    buyoutPrice: number | null,
    startingPrice: number,
    isPrivate: boolean,
    description: string,
  ) => Promise<IpcInvokeMap["createRivenAuction"]["return"]>;
  onHelperDownloadProgress: (callback: (progress: IpcEventMap["helper-download-progress"]) => void) => () => void;
}
