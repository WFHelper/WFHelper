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
import type { RelicDatabase } from "./relics.js";
import type { WorldState } from "./world.js";

export interface CycleAlerts {
  earth: boolean;
  cetus: boolean;
  vallis: boolean;
  cambion: boolean;
}

export interface FissureAlert {
  id: string;
  tier: string; // tier name or "any"
  missionType: string; // mission type or "any"
  steelPath: "any" | "normal" | "steel";
}

export interface OverlaySettings {
  autoTriggerEnabled: boolean;
  hotkeyEnabled: boolean;
  hotkey: string;
  interactionHotkeyEnabled: boolean;
  interactionHotkey: string;
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
  cycleAlerts: CycleAlerts;
  fissureAlerts: FissureAlert[];
  wfmNotificationsEnabled: boolean;
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

export interface HelperStatus {
  exeFound: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  inventoryLastModified: number | null;
}

export interface HelperDownloadProgress {
  stage: "resolving" | "downloading" | "done" | "error";
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

export type WfmOrderResult = WfmOrder | WfmMutationError;
export type WfmDeleteOrderResult = WfmDeleteResult | WfmMutationError;
export type WfmSetVisibleResult = Array<WfmOrder | WfmMutationError>;
export type WfmOrdersResponse = WfmOrdersResult | WfmMutationError;
export type WfmContractsResponse = WfmContractsResult | WfmMutationError;
export type WfmSearchResponse = WfmSearchItem[] | WfmMutationError;
export type WfmLookupItemResponse = WfmLookupItem | WfmMutationError;
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
  searchSimilarRivens: {
    args: [weaponName: string, positiveStats: string[], negativeStats: string[]];
    return: WfmRivenListing[];
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
  getWeaponRivenType: {
    args: [weaponName: string];
    return: string | null;
  };
  createRivenAuction: {
    args: [
      weaponName: string,
      stats: { tag: string; value: number; positive: boolean }[],
      rerolls: number,
      masteryReq: number,
      polarity: string,
      modRank: number,
      buyoutPrice: number | null,
      startingPrice: number,
      isPrivate: boolean,
      description: string,
    ];
    return: { ok: boolean; auctionId?: string; error?: string };
  };
}

export interface RivenStatOption {
  tag: string;
  wfmUrlName: string;
  displayName: string;
}

export interface DecodedRivenStat {
  tag: string;
  name: string;
  displayValue: number;
  rollFloat: number;
  grade: string;
  positive: boolean;
  multiplier: boolean;
}

export interface DecodedRiven {
  itemId: string;
  weaponName: string;
  weaponUniqueName: string;
  rivenName: string;
  masteryReq: number;
  currentRank: number;
  maxRank: number;
  rerolls: number;
  polarity: string;
  disposition: number;
  stats: DecodedRivenStat[];
  overallGrade: string;
  attributeGrade: string;
  statPerfectness: number;
  rivenType: string;
}

export interface VeiledRivenEntry {
  itemType: string;
  label: string;
  challengeType?: string;
  challengeDesc?: string;
  challengeProgress?: number;
  challengeRequired?: number;
}

export interface VeiledRivenGroup {
  itemType: string;
  label: string;
  count: number;
}

export interface RivenResult {
  unveiled: DecodedRiven[];
  veiled: VeiledRivenEntry[];
  veiledUnseen: VeiledRivenGroup[];
}

export interface WfmRivenListing {
  id: string;
  seller: string;
  platinum: number;
  stats: { name: string; value: number; positive: boolean }[];
  rerolls: number;
  startingPrice: number | null;
  buyoutPrice: number | null;
  isDirectSell: boolean;
}

export interface TradeItem {
  internalName: string;
  displayName: string;
  count: number;
  direction: "received" | "given";
}

export interface TradeEvent {
  id: string;
  date: string;                    // ISO datetime
  type: "sale" | "purchase";
  platChange: number;              // always positive
  items: TradeItem[];
  partner?: string;                // trading partner username (best-effort from EE.log)
}

export interface WfmNotification {
  type: "whisper" | "trade";
  from: string;
  content: string;
}

export interface DailyStatEntry {
  date: string;           // "YYYY-MM-DD"
  platDelta: number;
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;    // net change in Void Ducats (DUCTCREDITS)
  ayaDelta: number;       // net change in Aya (PrimeTokens)
  relicsOpened: number;   // relics consumed today (LevelKeys decrease tracking)
  daysPlayed: number;     // 1 = inventory data received; 0 = gap/imported entry
  dailyTrades: number;    // trades detected or imported for this day
  absPlat?: number;       // absolute platinum balance at end of day
  absCredits?: number;    // absolute credits balance at end of day
  absEndo?: number;       // absolute endo balance at end of day
  absDucats?: number;     // absolute ducats balance at end of day
  absAya?: number;        // absolute aya balance at end of day
}

export interface SessionStats {
  platDelta: number;
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;
  ayaDelta: number;
  currentPlat: number | null;
  currentCredits: number | null;
  currentEndo: number | null;
  currentDucats: number | null;
  currentAya: number | null;
  hasData: boolean;
}

export interface IpcEventMap {
  "inventory-updated": RawInventoryData;
  "app-update-status": AppUpdateState;
  "wfm:notification": WfmNotification;
  "helper-download-progress": HelperDownloadProgress;
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

