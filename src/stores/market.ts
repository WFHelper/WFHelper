import { writable } from "svelte/store";
import type {
  MarketTab,
  OrderModalState,
  WfmContractsResult,
  WfmOrdersResult,
  WfmSession,
  WfmStatus,
} from "../types/market.js";

export const marketSession = writable<WfmSession>({
  loggedIn: false,
  userName: null,
  platform: "pc",
});

export const marketOrders = writable<WfmOrdersResult>({ sell: [], buy: [] });
export const marketContracts = writable<WfmContractsResult>({
  contracts: [],
  page: 1,
  totalPages: null,
  hasMore: false,
});
export const marketTypeTab = writable<MarketTab>("sell");
export const marketStatus = writable<WfmStatus | null>(null);
export const marketSelected = writable<Set<string>>(new Set());
export const marketOrdersLastFetch = writable<number>(0);
export const marketContractsLastFetch = writable<number>(0);
export const orderModalState = writable<OrderModalState | null>(null);
