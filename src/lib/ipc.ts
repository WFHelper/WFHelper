import type { IpcEventMap, IpcInvokeMap, IpcSendMap } from "../types/ipc.js";

type InvokeKey = keyof IpcInvokeMap;
type EventChannel = keyof IpcEventMap;
type SendChannel = keyof IpcSendMap;

const invokeHandlers = {
  getInventory: () => window.api.getInventory(),
  openInventoryFile: () => window.api.openInventoryFile(),
  getInventoryStatus: () => window.api.getInventoryStatus(),
  checkAlecaFrame: () => window.api.checkAlecaFrame(),
  loadAlecaFrame: () => window.api.loadAlecaFrame(),
  openAlecaFrameJson: () => window.api.openAlecaFrameJson(),
  getItemDatabase: () => window.api.getItemDatabase(),
  getWorldState: () => window.api.getWorldState(),
  getRelicDatabase: () => window.api.getRelicDatabase(),
  getWfmItems: () => window.api.getWfmItems(),
  wfmSignIn: (creds) => window.api.wfmSignIn(creds),
  wfmSignOut: () => window.api.wfmSignOut(),
  wfmGetSession: () => window.api.wfmGetSession(),
  wfmGetOrders: () => window.api.wfmGetOrders(),
  wfmGetContracts: (query) => window.api.wfmGetContracts(query),
  wfmCreateOrder: (params) => window.api.wfmCreateOrder(params),
  wfmUpdateOrder: (orderId, updates) => window.api.wfmUpdateOrder(orderId, updates),
  wfmDeleteOrder: (orderId) => window.api.wfmDeleteOrder(orderId),
  wfmSetVisible: (orderIds, visible) => window.api.wfmSetVisible(orderIds, visible),
  wfmSearchItems: (query, limit) => window.api.wfmSearchItems(query, limit),
  wfmGetMe: () => window.api.wfmGetMe(),
  wfmSetStatus: (status) => window.api.wfmSetStatus(status),
  getMasteryProgress: () => window.api.getMasteryProgress(),
  setDebugMode: (enabled) => window.api.setDebugMode(enabled),
  checkForAppUpdates: () => window.api.checkForAppUpdates(),
  getAppUpdateState: () => window.api.getAppUpdateState(),
  installDownloadedUpdate: () => window.api.installDownloadedUpdate(),
  getOverlaySettings: () => window.api.getOverlaySettings(),
  setOverlaySettings: (settings) => window.api.setOverlaySettings(settings),
  openOcrCropDebugger: () => window.api.openOcrCropDebugger(),
} satisfies {
  [K in InvokeKey]: (...args: IpcInvokeMap[K]["args"]) => Promise<IpcInvokeMap[K]["return"]>;
};

const eventHandlers = {
  "inventory-updated": (callback: (data: IpcEventMap["inventory-updated"]) => void) =>
    window.api.onInventoryUpdated(callback),
  "app-update-status": (callback: (state: IpcEventMap["app-update-status"]) => void) =>
    window.api.onAppUpdateStatus(callback),
} satisfies {
  [K in EventChannel]: (callback: (payload: IpcEventMap[K]) => void) => () => void;
};

const sendHandlers = {
  "window-minimize": () => window.api.minimizeWindow(),
  "window-maximize": () => window.api.maximizeWindow(),
  "window-close": () => window.api.closeWindow(),
  "toggle-overlay": () => window.api.toggleOverlay(),
  "simulate-relic-trigger": () => window.api.simulateRelicTrigger(),
  "open-external": (url: IpcSendMap["open-external"][0]) => window.api.openExternal(url),
} satisfies {
  [K in SendChannel]: (...args: IpcSendMap[K]) => void;
};

export function invoke<K extends InvokeKey>(
  channel: K,
  ...args: IpcInvokeMap[K]["args"]
): Promise<IpcInvokeMap[K]["return"]> {
  const handler = invokeHandlers[channel] as (
    ...handlerArgs: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["return"]>;
  return handler(...args);
}

export function on<K extends EventChannel>(
  channel: K,
  callback: (payload: IpcEventMap[K]) => void,
): () => void {
  const handler = eventHandlers[channel] as (
    listener: (payload: IpcEventMap[K]) => void,
  ) => () => void;
  return handler(callback);
}

export function send<K extends SendChannel>(channel: K, ...args: IpcSendMap[K]): void {
  const handler = sendHandlers[channel] as (...sendArgs: IpcSendMap[K]) => void;
  handler(...args);
}

export const ipc = {
  invoke,
  on,
  send,
  getInventory: () => invoke("getInventory"),
  openInventoryFile: () => invoke("openInventoryFile"),
  getInventoryStatus: () => invoke("getInventoryStatus"),
  checkAlecaFrame: () => invoke("checkAlecaFrame"),
  loadAlecaFrame: () => invoke("loadAlecaFrame"),
  openAlecaFrameJson: () => invoke("openAlecaFrameJson"),
  getItemDatabase: () => invoke("getItemDatabase"),
  getWorldState: () => invoke("getWorldState"),
  getRelicDatabase: () => invoke("getRelicDatabase"),
  getWfmItems: () => invoke("getWfmItems"),
  wfmSignIn: (...args: IpcInvokeMap["wfmSignIn"]["args"]) => invoke("wfmSignIn", ...args),
  wfmSignOut: () => invoke("wfmSignOut"),
  wfmGetSession: () => invoke("wfmGetSession"),
  wfmGetOrders: () => invoke("wfmGetOrders"),
  wfmGetContracts: (...args: IpcInvokeMap["wfmGetContracts"]["args"]) =>
    invoke("wfmGetContracts", ...args),
  wfmCreateOrder: (...args: IpcInvokeMap["wfmCreateOrder"]["args"]) =>
    invoke("wfmCreateOrder", ...args),
  wfmUpdateOrder: (...args: IpcInvokeMap["wfmUpdateOrder"]["args"]) =>
    invoke("wfmUpdateOrder", ...args),
  wfmDeleteOrder: (...args: IpcInvokeMap["wfmDeleteOrder"]["args"]) =>
    invoke("wfmDeleteOrder", ...args),
  wfmSetVisible: (...args: IpcInvokeMap["wfmSetVisible"]["args"]) =>
    invoke("wfmSetVisible", ...args),
  wfmSearchItems: (...args: IpcInvokeMap["wfmSearchItems"]["args"]) =>
    invoke("wfmSearchItems", ...args),
  wfmGetMe: () => invoke("wfmGetMe"),
  wfmSetStatus: (...args: IpcInvokeMap["wfmSetStatus"]["args"]) => invoke("wfmSetStatus", ...args),
  getMasteryProgress: () => invoke("getMasteryProgress"),
  setDebugMode: (...args: IpcInvokeMap["setDebugMode"]["args"]) => invoke("setDebugMode", ...args),
  checkForAppUpdates: () => invoke("checkForAppUpdates"),
  getAppUpdateState: () => invoke("getAppUpdateState"),
  installDownloadedUpdate: () => invoke("installDownloadedUpdate"),
  getOverlaySettings: () => invoke("getOverlaySettings"),
  setOverlaySettings: (...args: IpcInvokeMap["setOverlaySettings"]["args"]) =>
    invoke("setOverlaySettings", ...args),
  openOcrCropDebugger: () => invoke("openOcrCropDebugger"),
  onInventoryUpdated: (callback: (data: IpcEventMap["inventory-updated"]) => void) =>
    on("inventory-updated", callback),
  onAppUpdateStatus: (callback: (state: IpcEventMap["app-update-status"]) => void) =>
    on("app-update-status", callback),
  minimizeWindow: () => send("window-minimize"),
  maximizeWindow: () => send("window-maximize"),
  closeWindow: () => send("window-close"),
  toggleOverlay: () => send("toggle-overlay"),
  simulateRelicTrigger: () => send("simulate-relic-trigger"),
  openExternal: (...args: IpcSendMap["open-external"]) => send("open-external", ...args),
} as const;
