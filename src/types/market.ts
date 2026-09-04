import type { WfmStatus } from "../../config/shared/wfm.js";
export type { WfmStatus };
export type {
  WfmContract,
  WfmContractAttribute,
  WfmContractsQuery,
  WfmContractsResult,
} from "../../config/shared/wfmContracts.js";
export type OrderType = "sell" | "buy";
export type MarketTab = "sell" | "buy" | "rivens" | "browse" | "alerts";

export interface WfmSession {
  loggedIn: boolean;
  userName: string | null;
  platform: string;
  error?: string;
}

export interface WfmOrder {
  id: string;
  orderType: OrderType | string;
  platinum: number;
  quantity: number;
  perTrade?: number;
  visible: boolean;
  modRank: number | null;
  subtype?: string | null;
  itemId: string | null;
  itemName: string;
  itemUrlName: string | null;
  itemThumb: string | null;
  [key: string]: unknown;
}

export interface WfmOrdersResult {
  sell: WfmOrder[];
  buy: WfmOrder[];
}

export interface WfmSearchItem {
  id: string;
  item_name: string;
  url_name?: string | null;
  thumb?: string | null;
  icon?: string | null;
  maxRank?: number | null;
  [key: string]: unknown;
}

export interface WfmLookupItem {
  id: string;
  item_name: string;
  url_name: string;
  thumb: string | null;
  icon: string | null;
}

export interface WfmMutationError {
  error: string;
  [key: string]: unknown;
}

export interface WfmDeleteResult {
  deleted: boolean;
  id: string;
}

export interface WfmStatusResult {
  status: WfmStatus;
}

export interface WfmPresenceState {
  status: WfmStatus | null;
  /** Epoch ms the current status drops to invisible; null while held indefinitely. */
  expiresAt: number | null;
  /** True while Warframe running is what is driving the status. */
  autoActive: boolean;
  /** True while an away rule (idle PC, or Warframe closed) is holding invisible. */
  awayActive: boolean;
}

export interface WfmUserProfile {
  status?: WfmStatus;
  [key: string]: unknown;
}

export interface WfmCreateOrderInput {
  itemId: string;
  orderType: OrderType;
  platinum: number;
  quantity: number;
  visible?: boolean;
  modRank?: number;
  subtype?: string;
}

export interface WfmUpdateOrderInput {
  platinum?: number;
  quantity?: number;
  visible?: boolean;
  modRank?: number;
  subtype?: string;
}

/** Market snapshot labels shown next to the price field while editing. */
export interface OrderModalHint {
  wts: string;
  wtb: string;
  median: string;
}

export interface OrderModalState {
  mode: "create" | "edit";
  order: WfmOrder | null;
  hint?: OrderModalHint | null;
  draft?: {
    item?: WfmLookupItem | null;
    orderType?: OrderType;
    modRank?: number | null;
    maxRank?: number | null;
    /** Preselected order subtype, e.g. a relic refinement. */
    subtype?: string | null;
  };
}
