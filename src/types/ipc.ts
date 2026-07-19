import type { MasteryData, RawInventoryData, ItemDbEntry } from "./inventory.js";
import type {
  WfmContractsQuery,
  WfmContractsResult,
  WfmCreateOrderInput,
  WfmDeleteResult,
  WfmLookupItem,
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
import type { DropSearchMode, DropSearchResult } from "./drops.js";
import type { RelicDatabase } from "./relics.js";
import type { WorldState } from "./world.js";

interface CycleAlerts {
  earth: boolean;
  cetus: boolean;
  vallis: boolean;
  cambion: boolean;
  duviri: boolean;
}

export interface FissureAlert {
  id: string;
  tier: string; // tier name or "any"
  missionType: string; // mission type or "any"
  steelPath: "any" | "normal" | "steel";
  planet: string; // planet name or "any"
}

type OverlayWindowKey = "reward" | "planner" | "rivenLeft" | "rivenRight" | "arbiSummary";

interface OverlaySavedWindowBounds {
  x: number;
  y: number;
  displayId?: string | null;
}

export interface OverlaySettings {
  autoTriggerEnabled: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  interactionHotkeyEnabled: boolean;
  interactionHotkey: string;
  worldNotificationsEnabled: boolean;
  cycleAlerts: CycleAlerts;
  cycleAlertMinutesBefore: number;
  fissureAlerts: FissureAlert[];
  notificationSoundEnabled: boolean;
  wfmNotificationsEnabled: boolean;
  messageNotificationsEnabled: boolean;
  messageNotificationsWhileFocused: boolean;
  autoCloseWfmOrders: boolean;
  relicRewardsOverlayEnabled: boolean;
  relicRecommendationOverlayEnabled: boolean;
  tradeNotificationOverlayEnabled: boolean;
  rivenOverlayEnabled: boolean;
  arbiSummaryOverlayEnabled: boolean;
  arbiTrackingEnabled: boolean;
  ocrDebugImagesEnabled: boolean;
  /** Main-window zoom multiplier applied on top of the display-derived base. */
  uiScale: number;
  overlayScale: number;
  overlayWindowScales: Partial<Record<OverlayWindowKey, number>>;
  overlayWindowBounds: Partial<Record<OverlayWindowKey, OverlaySavedWindowBounds>>;
  overlayDragHintDismissed: boolean;
}

type AppUpdateStatus =
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
  releaseNotes?: string | null;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  timestamp: number;
}

interface AppUpdateCheckResult {
  ok: boolean;
  source?: string;
  message?: string;
  state: AppUpdateState;
}

interface AppUpdateInstallResult {
  ok: boolean;
  message?: string;
}

interface AppRuntimeInfo {
  isPackaged: boolean;
}

interface InventoryReadError {
  kind: "parse" | "read";
  message: string;
  path: string;
  at: number;
}

interface InventoryStatus {
  path: string | null;
  found: boolean;
  /**
   * Most recent inventory read/parse failure; cleared on success. Distinguishes
   * "no file discovered" (null) from "file unreadable/corrupt".
   */
  lastError?: InventoryReadError | null;
}

export interface HelperStatus {
  exeFound: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  inventoryLastModified: number | null;
  installerAutoInstallHelper: boolean | null;
}

export interface HelperDownloadProgress {
  stage: DownloadStage;
  percent: number;
  bytesReceived: number;
  bytesTotal: number;
  error?: string;
}

export type WfmItemsLookup = Record<
  string,
  {
    url_name: string;
    item_name?: string;
    thumb?: string | null;
    icon?: string | null;
    maxRank?: number | null;
    gameRef?: string | null;
  }
>;
export type ItemDbLookup = Record<string, ItemDbEntry>;

type WfmOrderResult = WfmOrder | WfmMutationError;
type WfmDeleteOrderResult = WfmDeleteResult | WfmMutationError;
type WfmSetVisibleResult = Array<WfmOrder | WfmMutationError>;
type WfmOrdersResponse = WfmOrdersResult | WfmMutationError;
type WfmContractsResponse = WfmContractsResult | WfmMutationError;
type WfmSearchResponse = WfmSearchItem[] | WfmMutationError;
type WfmLookupItemResponse = WfmLookupItem | WfmMutationError;
type WfmStatusResponse = WfmStatusResult | WfmMutationError;
type WfmSessionResponse = WfmSession;
type WfmSignInResponse = WfmSession;
type WfmMeResponse = WfmUserProfile | WfmMutationError | null;

import type {
  CreateRivenAuctionPayload,
  DecodedRiven,
  UpdateRivenAuctionPayload,
  VeiledRivenEntry,
  VeiledRivenGroup,
} from "../../config/shared/rivenTypes.js";
export type {
  CreateRivenAuctionPayload,
  DecodedRiven,
  UpdateRivenAuctionPayload,
  VeiledRivenEntry,
  VeiledRivenGroup,
};

export interface IpcInvokeMap {
  getInventory: {
    args: [];
    return: RawInventoryData | null;
  };
  openInventoryFile: {
    args: [];
    return: RawInventoryData | null;
  };
  openAlecaFrameInventoryFile: {
    args: [];
    return: RawInventoryData | null;
  };
  getInventoryStatus: {
    args: [];
    return: InventoryStatus;
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
  wfmGetContracts: {
    args: [query?: WfmContractsQuery];
    return: WfmContractsResponse;
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
  wfmLookupItemBySlug: {
    args: [slug: string];
    return: WfmLookupItemResponse;
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
  getOverlayPlacementLayout: {
    args: [];
    return: {
      area: { width: number; height: number };
      overlays: Record<
        OverlayWindowKey,
        { x: number; y: number; width: number; height: number; scale: number }
      >;
    };
  };
  saveOverlayPlacement: {
    args: [key: OverlayWindowKey, pos: { xFrac: number; yFrac: number }];
    return: { ok: boolean };
  };
  saveOverlayScale: {
    args: [key: OverlayWindowKey, scale: number];
    return: { ok: boolean };
  };
  searchDrops: {
    args: [query: string, mode: DropSearchMode];
    return: DropSearchResult;
  };
  getOverlaySettings: {
    args: [];
    return: OverlaySettings;
  };
  setOverlaySettings: {
    args: [settings: Partial<OverlaySettings>];
    return: OverlaySettings;
  };
  checkForAppUpdates: {
    args: [];
    return: AppUpdateCheckResult;
  };
  getAppUpdateState: {
    args: [];
    return: AppUpdateState;
  };
  downloadAppUpdate: {
    args: [];
    return: AppUpdateCheckResult;
  };
  installDownloadedUpdate: {
    args: [];
    return: AppUpdateInstallResult;
  };
  getAppRuntimeInfo: {
    args: [];
    return: AppRuntimeInfo;
  };
  openScanDebugFolder: {
    args: [];
    return: { ok: boolean };
  };
  loadRankedHotset: {
    args: [];
    return: Record<string, unknown> | null;
  };
  saveRankedHotset: {
    args: [data: Record<string, unknown>];
    return: { ok: boolean };
  };
  loadSnapshotCache: {
    args: [];
    return: Record<string, unknown> | null;
  };
  saveSnapshotCache: {
    args: [data: Record<string, unknown>];
    return: { ok: boolean };
  };
  getStatsHistory: {
    args: [];
    return: DailyStatEntry[];
  };
  getStatsCurrentSession: {
    args: [];
    return: SessionStats;
  };
  importStatsHistory: {
    args: [raw: unknown[]];
    return: { ok: boolean; count: number };
  };
  getTradeLog: {
    args: [];
    return: TradeEvent[];
  };
  importTradeLog: {
    args: [events: TradeEvent[]];
    return: { ok: boolean; count: number };
  };
  getHelperStatus: {
    args: [];
    return: HelperStatus;
  };
  runHelperNow: {
    args: [];
    return: { ok: boolean };
  };
  downloadHelper: {
    args: [];
    return: { ok: boolean; error?: string };
  };
  getRivens: {
    args: [];
    return: RivenResult;
  };
  getRivenWeaponNames: {
    args: [];
    return: string[];
  };
  getRivenStatOptions: {
    args: [];
    return: RivenStatOption[];
  };
  searchRivenAuctions: {
    args: [weaponName: string, positiveWfmNames: string[], negativeWfmNames: string[]];
    return: WfmRivenListing[];
  };
  getRivenBestAttributes: {
    args: [weaponName: string];
    return: RivenBestAttributes | null;
  };
  createRivenAuction: {
    args: [payload: CreateRivenAuctionPayload];
    return: { ok: boolean; auctionId?: string; error?: string };
  };
  updateRivenAuction: {
    args: [payload: UpdateRivenAuctionPayload];
    return: { ok: boolean; auctionId?: string; error?: string };
  };
  getArbiRuns: {
    args: [];
    return: ArbiRunsPayload;
  };
  setArbiRunVitus: {
    args: [id: string, vitus: number | null];
    return: ArbiRunRecord | null;
  };
  deleteArbiRun: {
    args: [id: string];
    return: { ok: boolean };
  };
  deleteArbiRunLog: {
    args: [id: string];
    return: ArbiRunRecord | null;
  };
  exportArbiRunLog: {
    args: [id: string];
    return: { ok: boolean };
  };
  importArbiLog: {
    args: [];
    return: ArbiImportResult;
  };
  saveArbiRunImage: {
    args: [id: string, png: Uint8Array];
    return: { ok: boolean };
  };
  showArbiRunLogInFolder: {
    args: [id: string];
    return: { ok: boolean };
  };
  getArbiSchedule: {
    args: [];
    return: ArbiSchedulePayload;
  };
  setArbiScheduleOccurrence: {
    args: [key: string, enabled: boolean];
    return: ArbiScheduleAlerts | null;
  };
  setArbiScheduleFavorite: {
    args: [nodeId: string, enabled: boolean];
    return: ArbiScheduleAlerts | null;
  };
  setArbiScheduleLead: {
    args: [minutes: number];
    return: ArbiScheduleAlerts | null;
  };
}

export interface RivenStatOption {
  tag: string;
  wfmUrlName: string;
  displayName: string;
}

export interface RivenBestAttributes {
  positives: string[];
  negatives: string[];
}

interface RivenResult {
  unveiled: DecodedRiven[];
  veiled: VeiledRivenEntry[];
  veiledUnseen: VeiledRivenGroup[];
}

export interface WfmRivenListing {
  id: string;
  seller: string;
  sellerStatus: string | null;
  platinum: number;
  stats: { name: string; value: number; positive: boolean }[];
  rerolls: number;
  startingPrice: number | null;
  buyoutPrice: number | null;
  isDirectSell: boolean;
}

type WfmNotification =
  | { type: "whisper" | "trade"; from: string; content: string }
  // The persistent WS listener gave up after repeated sign-in rejections;
  // the session token is dead and the user must log in again.
  | { type: "listener-auth-failed" };

// Single source of truth for trade/stat types lives in config/shared/statsTypes.ts.
import type {
  DailyStatEntry,
  DownloadStage,
  SessionStats,
  TradeEvent,
  TradeItem,
  TradeType,
} from "../../config/shared/statsTypes.js";
import type { TradeMatchPayload } from "../../config/shared/tradeMatch.js";
export type { DailyStatEntry, SessionStats, TradeEvent, TradeItem, TradeType };

// Single source of truth for arbitration types lives in config/shared/arbiTypes.ts.
import type {
  ArbiImportResult,
  ArbiRunRecord,
  ArbiRunStats,
  ArbiRunsPayload,
} from "../../config/shared/arbiTypes.js";
export type { ArbiRunRecord, ArbiRunStats };
import type {
  ArbiScheduleAlerts,
  ArbiScheduleEntry,
  ArbiSchedulePayload,
} from "../../config/shared/arbiScheduleTypes.js";
export type { ArbiScheduleAlerts, ArbiScheduleEntry };

type WfmTradeMatchEvent = TradeMatchPayload;

interface TradeRecordedEvent {
  trade: TradeEvent;
  wfmMatch: WfmTradeMatchEvent | null;
}

export interface IpcEventMap {
  "inventory-updated": RawInventoryData;
  "item-db-updated": undefined;
  "app-update-status": AppUpdateState;
  "wfm:notification": WfmNotification;
  "helper-download-progress": HelperDownloadProgress;
  "trade-recorded": TradeRecordedEvent;
  "world-state-fetch-error": string;
  "arbi-run-saved": ArbiRunRecord;
  "arbi-open-run": string;
}

export interface IpcSendMap {
  "window-minimize": [];
  "window-maximize": [];
  "window-close": [];
  "toggle-overlay": [];
  "simulate-relic-trigger": [];
  "overlay-theme-updated": [themeVars: Record<string, string>];
  "overlay:push-relic-filters": [filters: { squadSize: number; tierFilter: string | null }];
  "open-external": [url: string];
}
