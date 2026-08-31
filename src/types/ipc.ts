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
  WfmPresenceState,
  WfmSearchItem,
  WfmSession,
  WfmStatus,
  WfmStatusResult,
  WfmUpdateOrderInput,
  WfmUserProfile,
} from "./market.js";
import type { DropSearchMode, DropSearchResult } from "./drops.js";
import type {
  WorkbenchExecuteResult,
  WorkbenchOverrideAck,
  WorkbenchPlan,
  WorkbenchPlanValidation,
  WorkbenchResolveReviewPayload,
  WorkbenchReviewReport,
  WorkbenchSafetySnapshot,
  WorkbenchState,
} from "../../config/shared/tradeWorkbenchTypes.js";
import type { RelicDatabase } from "./relics.js";
import type { WorldState } from "./world.js";
import type { HelperStatus } from "../../config/shared/apiHelperTypes.js";
import type { CodexScansResult } from "../../config/shared/codexTypes.js";
import type { InventorySource } from "../../config/shared/inventorySource.js";
import type { DisplayPreference, LinuxDisplayInfo } from "../../config/shared/linuxDisplay.js";
import type {
  NotificationChannelState,
  NotificationEntry,
  NotificationSource,
  SetWebhookResult,
  SourceChannelToggles,
  WebhookChannel,
  WebhookTestResult,
} from "../../config/shared/notifications.js";
import type {
  MarketAlertEngineStatus,
  MarketAlertHit,
  MarketAlertImportOutcome,
  MarketAlertListResult,
  MarketAlertSavePayload,
  MarketAlertSaveResult,
  MarketAlertTestFireResult,
} from "../../config/shared/marketAlertTypes.js";
import type { OverlaySettings, OverlayWindowKey } from "../../config/runtime/overlaySettings.js";

export type { HelperStatus } from "../../config/shared/apiHelperTypes.js";
export type { InventorySource } from "../../config/shared/inventorySource.js";
export type {
  FissureAlert,
  OverlaySettings,
  OverlayWindowKey,
} from "../../config/runtime/overlaySettings.js";

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
  kind: "parse" | "read" | "watch";
  message: string;
  path: string;
  at: number;
}

interface InventoryStatus {
  path: string | null;
  found: boolean;
  /** The user's persisted pick. Matches the loaded file whenever `path` is set. */
  source: InventorySource;
  /** mtime of the loaded file; the only date behind undated point-in-time fields. */
  modifiedAt: number | null;
  /** The last read failure, or null when no file was discovered or after success. */
  lastError?: InventoryReadError | null;
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
    args: [source: Exclude<InventorySource, "aleca">];
    return: RawInventoryData | null;
  };
  setInventorySource: {
    args: [source: InventorySource];
    return: { source: InventorySource };
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
  wfmPresenceState: {
    args: [];
    return: WfmPresenceState;
  };
  getMasteryProgress: {
    args: [];
    return: MasteryData | null;
  };
  getCodexScans: {
    args: [force?: boolean];
    return: CodexScansResult;
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
  getLinuxDisplay: {
    args: [];
    return: LinuxDisplayInfo;
  };
  setLinuxDisplay: {
    args: [preference: DisplayPreference];
    return: LinuxDisplayInfo;
  };
  getOverlaySettings: {
    args: [];
    return: OverlaySettings;
  };
  getDetectedWarframeUiScale: {
    args: [];
    return: number | null;
  };
  setOverlaySettings: {
    args: [settings: Partial<OverlaySettings>];
    return: OverlaySettings;
  };
  confirmDialog: {
    args: [payload: { message: string; okLabel: string; cancelLabel: string }];
    return: boolean;
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
  openLogFolder: {
    args: [];
    return: { ok: boolean };
  };
  getNotificationHistory: {
    args: [];
    return: NotificationEntry[];
  };
  clearNotificationHistory: {
    args: [];
    return: void;
  };
  removeNotificationEntry: {
    args: [string];
    return: boolean;
  };
  sendTestNotification: {
    args: [];
    return: boolean;
  };
  getNotificationChannels: {
    args: [];
    return: NotificationChannelState;
  };
  setNotificationWebhook: {
    args: [channel: WebhookChannel, url: string];
    return: SetWebhookResult;
  };
  clearNotificationWebhook: {
    args: [channel: WebhookChannel];
    return: NotificationChannelState;
  };
  setNotificationSourceChannels: {
    args: [source: NotificationSource, toggles: SourceChannelToggles];
    return: NotificationChannelState;
  };
  testNotificationWebhook: {
    args: [channel: WebhookChannel];
    return: WebhookTestResult;
  };
  marketAlertsList: {
    args: [];
    return: MarketAlertListResult;
  };
  marketAlertsSave: {
    args: [payload: MarketAlertSavePayload];
    return: MarketAlertSaveResult;
  };
  marketAlertsDelete: {
    args: [id: string];
    return: { ok: boolean };
  };
  marketAlertsSetEnabled: {
    args: [id: string, enabled: boolean];
    return: { ok: boolean };
  };
  marketAlertsGetHits: {
    args: [];
    return: MarketAlertHit[];
  };
  marketAlertsClearHits: {
    args: [];
    return: { ok: boolean };
  };
  marketAlertsStatus: {
    args: [];
    return: MarketAlertEngineStatus;
  };
  marketAlertsTestFire: {
    args: [id: string];
    return: MarketAlertTestFireResult;
  };
  marketAlertsExport: {
    args: [];
    return: string;
  };
  marketAlertsImport: {
    args: [text: string];
    return: MarketAlertImportOutcome;
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
  deleteRivenAuction: {
    args: [payload: { auctionId: string }];
    return: { ok: boolean; error?: string };
  };
  updateRivenAuction: {
    args: [payload: UpdateRivenAuctionPayload];
    return: { ok: boolean; auctionId?: string; error?: string };
  };
  getArbiRuns: {
    args: [];
    return: ArbiRunsPayload;
  };
  refreshArbiRuns: {
    args: [];
    return: ArbiRunsPayload;
  };
  setArbiRunVitus: {
    args: [id: string, vitus: number | null];
    return: ArbiRunRecord | null;
  };
  setArbiRunTags: {
    args: [id: string, tags: string[]];
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
  workbenchGetState: {
    args: [];
    return: WorkbenchState;
  };
  workbenchPreviewPlan: {
    args: [plan: WorkbenchPlan, safety: WorkbenchSafetySnapshot];
    return: WorkbenchPlanValidation | WfmMutationError;
  };
  workbenchExecutePlan: {
    args: [plan: WorkbenchPlan, safety: WorkbenchSafetySnapshot];
    return: WorkbenchExecuteResult;
  };
  workbenchCancelRun: {
    args: [];
    return: WorkbenchState;
  };
  workbenchAcknowledgeOverride: {
    args: [ack: WorkbenchOverrideAck];
    return: WorkbenchState | WfmMutationError;
  };
  workbenchReconcile: {
    args: [];
    return: WorkbenchReviewReport | WfmMutationError;
  };
  workbenchResolveReview: {
    args: [payload: WorkbenchResolveReviewPayload];
    return: WorkbenchState | WfmMutationError;
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

export type WfmNotification =
  | { type: "whisper" | "trade"; from: string; content: string }
  // The persistent WS listener gave up after repeated sign-in rejections;
  // the session token is dead and the user must log in again.
  | { type: "listener-auth-failed" }
  // WFM pushed an order/auction change made elsewhere (website, another client).
  | { type: "orders-changed" }
  // Main changed our presence (hold expiry, game launch/exit) - refresh the chips.
  | ({ type: "presence" } & WfmPresenceState);

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
  ArbiMissionType,
  ArbiRunRecord,
  ArbiRunStats,
  ArbiRunsPayload,
} from "../../config/shared/arbiTypes.js";
export type { ArbiMissionType, ArbiRunRecord, ArbiRunStats };
import type {
  ArbiScheduleAlerts,
  ArbiScheduleEntry,
  ArbiSchedulePayload,
} from "../../config/shared/arbiScheduleTypes.js";
export type { ArbiScheduleAlerts, ArbiScheduleEntry };

type WfmTradeMatchEvent = TradeMatchPayload;

interface TradeRecordedEvent {
  trade: TradeEvent;
  /** Every listing the trade auto-closed - one trade can settle several. */
  wfmMatches: WfmTradeMatchEvent[];
}

export interface IpcEventMap {
  "inventory-updated": RawInventoryData;
  "inventory-status-updated": InventoryStatus;
  "item-db-updated": undefined;
  "app-update-status": AppUpdateState;
  "wfm:notification": WfmNotification;
  "helper-download-progress": HelperDownloadProgress;
  "trade-recorded": TradeRecordedEvent;
  "world-state-fetch-error": string;
  "arbi-run-saved": ArbiRunRecord;
  "arbi-open-run": string;
  "warframe-ui-scale-updated": number | null;
  "notification-history-added": NotificationEntry;
  "notification-sound-play": undefined;
  "workbench-state": WorkbenchState;
}

export interface IpcSendMap {
  "window-minimize": [];
  "window-maximize": [];
  "window-close": [];
  "toggle-overlay": [];
  "simulate-relic-trigger": [];
  "overlay-theme-updated": [themeVars: Record<string, string>];
  "overlay-locale-updated": [locale: string];
  "game-locale-updated": [locale: string];
  "overlay:push-relic-filters": [filters: { squadSize: number; tierFilter: string | null }];
  "open-external": [url: string];
}
