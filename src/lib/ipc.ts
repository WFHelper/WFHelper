import type { IpcInvokeMap } from "../types/ipc.js";
import type { RawInventoryData } from "../types/inventory.js";

type InvokeKey = keyof IpcInvokeMap;

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
  wfmCreateOrder: (params) => window.api.wfmCreateOrder(params),
  wfmUpdateOrder: (orderId, updates) => window.api.wfmUpdateOrder(orderId, updates),
  wfmDeleteOrder: (orderId) => window.api.wfmDeleteOrder(orderId),
  wfmSetVisible: (orderIds, visible) => window.api.wfmSetVisible(orderIds, visible),
  wfmSearchItems: (query, limit) => window.api.wfmSearchItems(query, limit),
  wfmGetMe: () => window.api.wfmGetMe(),
  wfmSetStatus: (status) => window.api.wfmSetStatus(status),
  getMasteryProgress: () => window.api.getMasteryProgress(),
  setDebugMode: (enabled) => window.api.setDebugMode(enabled),
  getOverlaySettings: () => window.api.getOverlaySettings(),
  setOverlaySettings: (settings) => window.api.setOverlaySettings(settings),
} satisfies {
  [K in InvokeKey]: (
    ...args: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["return"]>;
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

export const ipc = {
  invoke,
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
  wfmCreateOrder: (...args: IpcInvokeMap["wfmCreateOrder"]["args"]) => invoke("wfmCreateOrder", ...args),
  wfmUpdateOrder: (...args: IpcInvokeMap["wfmUpdateOrder"]["args"]) => invoke("wfmUpdateOrder", ...args),
  wfmDeleteOrder: (...args: IpcInvokeMap["wfmDeleteOrder"]["args"]) => invoke("wfmDeleteOrder", ...args),
  wfmSetVisible: (...args: IpcInvokeMap["wfmSetVisible"]["args"]) => invoke("wfmSetVisible", ...args),
  wfmSearchItems: (...args: IpcInvokeMap["wfmSearchItems"]["args"]) => invoke("wfmSearchItems", ...args),
  wfmGetMe: () => invoke("wfmGetMe"),
  wfmSetStatus: (...args: IpcInvokeMap["wfmSetStatus"]["args"]) => invoke("wfmSetStatus", ...args),
  getMasteryProgress: () => invoke("getMasteryProgress"),
  setDebugMode: (...args: IpcInvokeMap["setDebugMode"]["args"]) => invoke("setDebugMode", ...args),
  getOverlaySettings: () => invoke("getOverlaySettings"),
  setOverlaySettings: (...args: IpcInvokeMap["setOverlaySettings"]["args"]) => invoke("setOverlaySettings", ...args),
  onInventoryUpdated: (callback: (data: RawInventoryData) => void) => {
    window.api.onInventoryUpdated(callback);
  },
  minimizeWindow: () => {
    window.api.minimizeWindow();
  },
  maximizeWindow: () => {
    window.api.maximizeWindow();
  },
  closeWindow: () => {
    window.api.closeWindow();
  },
  toggleOverlay: () => {
    window.api.toggleOverlay();
  },
  simulateRelicTrigger: () => {
    window.api.simulateRelicTrigger();
  },
  openExternal: (url: string) => {
    window.api.openExternal(url);
  },
} as const;
