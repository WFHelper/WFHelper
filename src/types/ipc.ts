import type { MasteryData, RawInventoryData, ItemDbEntry } from "./inventory.js";
import type {
  OrderModalState,
  WfmCreateOrderInput,
  WfmDeleteResult,
  WfmMutationError,
  WfmOrder,
  WfmOrdersResult,
  WfmSearchItem,
  WfmSession,
  WfmStatus,
  WfmStatusResult,
  WfmUpdateOrderInput,
  WfmUserProfile,
} from "./market.js";
import type { RelicDatabase } from "./relics.js";
import type { WorldState } from "./world.js";

export interface OverlaySettings {
  autoTriggerEnabled: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  cropDebugHotkeyEnabled: boolean;
  cropDebugHotkey: string;
  cropPreset: "balanced" | "tight" | "wide" | "custom";
  cropTopRatio: number;
  cropHeightRatio: number;
  ocrEngine: "windows" | "tesseract";
  ocrPasses: number;
  matchThreshold: number;
  ocrTimeoutMs: number;
  worldNotificationsEnabled: boolean;
}

export type AppUpdateStatus =
  | "idle"
  | "disabled"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  message?: string;
  version?: string | null;
  releaseName?: string | null;
  releaseDate?: string | null;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  timestamp: number;
}

export interface AppUpdateCheckResult {
  ok: boolean;
  source?: string;
  message?: string;
  state: AppUpdateState;
}

export interface AppUpdateInstallResult {
  ok: boolean;
  message?: string;
}

export interface InventoryStatus {
  path: string | null;
  found: boolean;
}

export interface AlecaFrameStatus {
  found: boolean;
  path: string | null;
  lastModified?: string | null;
  hasCachedData?: boolean;
}

export interface AlecaFrameLoadResult {
  success: boolean;
  data?: RawInventoryData;
  error?: string;
  fallbackUrl?: string;
}

export type WfmItemsLookup = Record<
  string,
  {
    url_name: string;
    item_name?: string;
    thumb?: string | null;
    icon?: string | null;
  }
>;
export type ItemDbLookup = Record<string, ItemDbEntry>;

export type WfmOrderResult = WfmOrder | WfmMutationError;
export type WfmDeleteOrderResult = WfmDeleteResult | WfmMutationError;
export type WfmSetVisibleResult = Array<WfmOrder | WfmMutationError>;
export type WfmOrdersResponse = WfmOrdersResult | WfmMutationError;
export type WfmSearchResponse = WfmSearchItem[] | WfmMutationError;
export type WfmStatusResponse = WfmStatusResult | WfmMutationError;
export type WfmSessionResponse = WfmSession;
export type WfmSignInResponse = WfmSession;
export type WfmMeResponse = WfmUserProfile | WfmMutationError | null;

export interface IpcInvokeMap {
  getInventory: {
    args: [];
    return: RawInventoryData | null;
  };
  openInventoryFile: {
    args: [];
    return: RawInventoryData | null;
  };
  getInventoryStatus: {
    args: [];
    return: InventoryStatus;
  };
  checkAlecaFrame: {
    args: [];
    return: AlecaFrameStatus;
  };
  loadAlecaFrame: {
    args: [];
    return: AlecaFrameLoadResult;
  };
  openAlecaFrameJson: {
    args: [];
    return: RawInventoryData | null;
  };
  getItemDatabase: {
    args: [];
    return: ItemDbLookup;
  };
  getWorldState: {
    args: [];
    return: WorldState | null;
  };
  getRelicDatabase: {
    args: [];
    return: RelicDatabase | null;
  };
  getWfmItems: {
    args: [];
    return: WfmItemsLookup;
  };
  wfmSignIn: {
    args: [{ email: string; password: string }];
    return: WfmSignInResponse;
  };
  wfmSignOut: {
    args: [];
    return: { loggedIn: false };
  };
  wfmGetSession: {
    args: [];
    return: WfmSessionResponse;
  };
  wfmGetOrders: {
    args: [];
    return: WfmOrdersResponse;
  };
  wfmCreateOrder: {
    args: [WfmCreateOrderInput];
    return: WfmOrderResult;
  };
  wfmUpdateOrder: {
    args: [orderId: string, updates: WfmUpdateOrderInput];
    return: WfmOrderResult;
  };
  wfmDeleteOrder: {
    args: [orderId: string];
    return: WfmDeleteOrderResult;
  };
  wfmSetVisible: {
    args: [orderIds: string[], visible: boolean];
    return: WfmSetVisibleResult;
  };
  wfmSearchItems: {
    args: [query: string, limit?: number];
    return: WfmSearchResponse;
  };
  wfmGetMe: {
    args: [];
    return: WfmMeResponse;
  };
  wfmSetStatus: {
    args: [status: WfmStatus];
    return: WfmStatusResponse;
  };
  getMasteryProgress: {
    args: [];
    return: MasteryData | null;
  };
  setDebugMode: {
    args: [enabled: boolean];
    return: { enabled: boolean };
  };
  getOverlaySettings: {
    args: [];
    return: OverlaySettings;
  };
  setOverlaySettings: {
    args: [settings: Partial<OverlaySettings>];
    return: OverlaySettings;
  };
  openOcrCropDebugger: {
    args: [];
    return: { ok: boolean; error?: string; settings?: OverlaySettings };
  };
  checkForAppUpdates: {
    args: [];
    return: AppUpdateCheckResult;
  };
  getAppUpdateState: {
    args: [];
    return: AppUpdateState;
  };
  installDownloadedUpdate: {
    args: [];
    return: AppUpdateInstallResult;
  };
}

export interface IpcEventMap {
  "inventory-updated": RawInventoryData;
  "app-update-status": AppUpdateState;
}

export interface IpcSendMap {
  "window-minimize": [];
  "window-maximize": [];
  "window-close": [];
  "toggle-overlay": [];
  "simulate-relic-trigger": [];
  "open-external": [url: string];
}

export type MarketOrderModalState = OrderModalState;
