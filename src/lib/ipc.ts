import type { IpcEventMap, IpcInvokeMap, IpcSendMap } from "../types/ipc.js";

type InvokeKey = keyof IpcInvokeMap;
type EventChannel = keyof IpcEventMap;
type SendChannel = keyof IpcSendMap;

export function invoke<K extends InvokeKey>(
  channel: K,
  ...args: IpcInvokeMap[K]["args"]
): Promise<IpcInvokeMap[K]["return"]> {
  const fn = window.api[channel] as (
    ...a: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["return"]>;
  return fn(...args);
}

const eventApiMap: Record<
  EventChannel,
  (cb: (payload: IpcEventMap[EventChannel]) => void) => () => void
> = {
  "inventory-updated": (cb) =>
    window.api.onInventoryUpdated(cb as (data: IpcEventMap["inventory-updated"]) => void),
  "app-update-status": (cb) =>
    window.api.onAppUpdateStatus(cb as (state: IpcEventMap["app-update-status"]) => void),
  "wfm:notification": (cb) =>
    window.api.onWfmNotification(cb as (n: IpcEventMap["wfm:notification"]) => void),
  "helper-download-progress": (cb) =>
    window.api.onHelperDownloadProgress(cb as (p: IpcEventMap["helper-download-progress"]) => void),
  "trade-recorded": (cb) =>
    window.api.onTradeRecorded(cb as (e: IpcEventMap["trade-recorded"]) => void),
  "world-state-fetch-error": (cb) =>
    window.api.onWorldStateFetchError(cb as (m: IpcEventMap["world-state-fetch-error"]) => void),
};

export function on<K extends EventChannel>(
  channel: K,
  callback: (payload: IpcEventMap[K]) => void,
): () => void {
  return (eventApiMap[channel] as (cb: (payload: IpcEventMap[EventChannel]) => void) => () => void)(
    callback as (payload: IpcEventMap[EventChannel]) => void,
  );
}

const sendApiMap: Record<SendChannel, (...args: never[]) => void> = {
  "window-minimize": () => window.api.minimizeWindow(),
  "window-maximize": () => window.api.maximizeWindow(),
  "window-close": () => window.api.closeWindow(),
  "toggle-overlay": () => window.api.toggleOverlay(),
  "simulate-relic-trigger": () => window.api.simulateRelicTrigger(),
  "overlay-theme-updated": (themeVars: Record<string, string>) =>
    window.api.updateOverlayTheme(themeVars),
  "overlay:push-relic-filters": (filters: { squadSize: number; tierFilter: string | null }) =>
    window.api.pushRelicFilters(filters),
  "open-external": (url: string) => window.api.openExternal(url),
};

export function send<K extends SendChannel>(channel: K, ...args: IpcSendMap[K]): void {
  (sendApiMap[channel] as (...a: IpcSendMap[K]) => void)(...args);
}

export const ipc = {
  invoke,
  on,
  send,
  getInventory: () => window.api.getInventory(),
  openInventoryFile: () => window.api.openInventoryFile(),
  getInventoryStatus: () => window.api.getInventoryStatus(),
  getItemDatabase: () => window.api.getItemDatabase(),
  getWorldState: () => window.api.getWorldState(),
  getRelicDatabase: () => window.api.getRelicDatabase(),
  getWfmItems: () => window.api.getWfmItems(),
  wfmSignIn: (...args: IpcInvokeMap["wfmSignIn"]["args"]) => window.api.wfmSignIn(...args),
  wfmSignOut: () => window.api.wfmSignOut(),
  wfmGetSession: () => window.api.wfmGetSession(),
  wfmGetOrders: () => window.api.wfmGetOrders(),
  wfmGetContracts: (...args: IpcInvokeMap["wfmGetContracts"]["args"]) =>
    window.api.wfmGetContracts(...args),
  wfmCreateOrder: (...args: IpcInvokeMap["wfmCreateOrder"]["args"]) =>
    window.api.wfmCreateOrder(...args),
  wfmUpdateOrder: (...args: IpcInvokeMap["wfmUpdateOrder"]["args"]) =>
    window.api.wfmUpdateOrder(...args),
  wfmDeleteOrder: (...args: IpcInvokeMap["wfmDeleteOrder"]["args"]) =>
    window.api.wfmDeleteOrder(...args),
  wfmSetVisible: (...args: IpcInvokeMap["wfmSetVisible"]["args"]) =>
    window.api.wfmSetVisible(...args),
  wfmSearchItems: (...args: IpcInvokeMap["wfmSearchItems"]["args"]) =>
    window.api.wfmSearchItems(...args),
  wfmLookupItemBySlug: (...args: IpcInvokeMap["wfmLookupItemBySlug"]["args"]) =>
    window.api.wfmLookupItemBySlug(...args),
  wfmGetMe: () => window.api.wfmGetMe(),
  wfmSetStatus: (...args: IpcInvokeMap["wfmSetStatus"]["args"]) => window.api.wfmSetStatus(...args),
  getMasteryProgress: () => window.api.getMasteryProgress(),
  setDebugMode: (...args: IpcInvokeMap["setDebugMode"]["args"]) => window.api.setDebugMode(...args),
  checkForAppUpdates: () => window.api.checkForAppUpdates(),
  getAppUpdateState: () => window.api.getAppUpdateState(),
  installDownloadedUpdate: () => window.api.installDownloadedUpdate(),
  getOverlaySettings: () => window.api.getOverlaySettings(),
  setOverlaySettings: (...args: IpcInvokeMap["setOverlaySettings"]["args"]) =>
    window.api.setOverlaySettings(...args),
  onInventoryUpdated: (callback: (data: IpcEventMap["inventory-updated"]) => void) =>
    window.api.onInventoryUpdated(callback),
  onAppUpdateStatus: (callback: (state: IpcEventMap["app-update-status"]) => void) =>
    window.api.onAppUpdateStatus(callback),
  onWfmNotification: (callback: (n: IpcEventMap["wfm:notification"]) => void) =>
    window.api.onWfmNotification(callback),
  minimizeWindow: () => window.api.minimizeWindow(),
  maximizeWindow: () => window.api.maximizeWindow(),
  closeWindow: () => window.api.closeWindow(),
  toggleOverlay: () => window.api.toggleOverlay(),
  simulateRelicTrigger: () => window.api.simulateRelicTrigger(),
  updateOverlayTheme: (...args: IpcSendMap["overlay-theme-updated"]) =>
    window.api.updateOverlayTheme(...args),
  pushRelicFilters: (...args: IpcSendMap["overlay:push-relic-filters"]) =>
    window.api.pushRelicFilters(...args),
  openExternal: (...args: IpcSendMap["open-external"]) => window.api.openExternal(...args),
  loadRankedHotset: () => window.api.loadRankedHotset(),
  saveRankedHotset: (...args: IpcInvokeMap["saveRankedHotset"]["args"]) =>
    window.api.saveRankedHotset(...args),
  loadSnapshotCache: () => window.api.loadSnapshotCache(),
  saveSnapshotCache: (...args: IpcInvokeMap["saveSnapshotCache"]["args"]) =>
    window.api.saveSnapshotCache(...args),
  getStatsHistory: () => window.api.getStatsHistory(),
  getStatsCurrentSession: () => window.api.getStatsCurrentSession(),
  importStatsHistory: (raw: unknown[]) => window.api.importStatsHistory(raw),
  getTradeLog: () => window.api.getTradeLog(),
  importTradeLog: (...args: IpcInvokeMap["importTradeLog"]["args"]) =>
    window.api.importTradeLog(...args),
  getHelperStatus: () => window.api.getHelperStatus(),
  runHelperNow: () => window.api.runHelperNow(),
  downloadHelper: () => window.api.downloadHelper(),
  getRivens: () => window.api.getRivens(),
  getRivenWeaponNames: () => window.api.getRivenWeaponNames(),
  getRivenStatOptions: () => window.api.getRivenStatOptions(),
  searchRivenAuctions: (...args: IpcInvokeMap["searchRivenAuctions"]["args"]) =>
    window.api.searchRivenAuctions(...args),
  getWeaponRivenType: (...args: IpcInvokeMap["getWeaponRivenType"]["args"]) =>
    window.api.getWeaponRivenType(...args),
  createRivenAuction: (...args: IpcInvokeMap["createRivenAuction"]["args"]) =>
    window.api.createRivenAuction(...args),
  onHelperDownloadProgress: (callback: (progress: IpcEventMap["helper-download-progress"]) => void) =>
    window.api.onHelperDownloadProgress(callback),
  onTradeRecorded: (callback: (event: IpcEventMap["trade-recorded"]) => void) =>
    window.api.onTradeRecorded(callback),
} as const;
