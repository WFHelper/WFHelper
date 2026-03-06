export type WfmStatus = "online" | "ingame" | "invisible";
export type MarketTab = "sell" | "buy" | "rivens";

export interface WfmSession {
  loggedIn: boolean;
  userName: string | null;
  platform: string;
  error?: string;
}

export interface WfmOrder {
  id: string;
  orderType: "sell" | "buy" | string;
  platinum: number;
  quantity: number;
  visible: boolean;
  modRank: number | null;
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

export interface WfmContractAttribute {
  urlName: string;
  label: string;
  value: number | string | null;
  positive: boolean | null;
}

export interface WfmContract {
  id: string;
  itemName: string;
  itemId: string | null;
  itemUrlName: string | null;
  weaponUrlName: string | null;
  itemThumb: string | null;
  platinum: number;
  buyoutPlatinum: number | null;
  startingPlatinum: number | null;
  quantity: number;
  visible: boolean;
  modRank: number | null;
  rerolls: number | null;
  masteryLevel: number | null;
  polarity: string | null;
  isDirectSell: boolean;
  listedAt: string | null;
  updatedAt: string | null;
  note: string | null;
  stats: WfmContractAttribute[];
  listingUrl: string;
  sourceType: string | null;
  [key: string]: unknown;
}

export interface WfmContractsResult {
  contracts: WfmContract[];
  page: number;
  totalPages: number | null;
  hasMore: boolean;
}

export interface WfmContractsQuery {
  page?: number;
  limit?: number;
}

export interface WfmSearchItem {
  id: string;
  item_name: string;
  url_name?: string | null;
  thumb?: string | null;
  icon?: string | null;
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

export interface WfmUserProfile {
  status?: WfmStatus;
  [key: string]: unknown;
}

export interface WfmCreateOrderInput {
  itemId: string;
  orderType: "sell" | "buy";
  platinum: number;
  quantity: number;
  visible?: boolean;
  modRank?: number;
}

export interface WfmUpdateOrderInput {
  platinum?: number;
  quantity?: number;
  visible?: boolean;
  modRank?: number;
}

export interface OrderModalState {
  mode: "create" | "edit";
  order: WfmOrder | null;
  draft?: {
    item?: WfmLookupItem | null;
    orderType?: "sell" | "buy";
    modRank?: number | null;
  };
}
