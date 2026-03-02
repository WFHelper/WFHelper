export type WfmStatus = "online" | "ingame" | "invisible";

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

export interface WfmSearchItem {
  id: string;
  item_name: string;
  thumb?: string | null;
  [key: string]: unknown;
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
}
