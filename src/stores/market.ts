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

interface MarketViewState {
  typeTab: MarketTab;
  status: WfmStatus | null;
  ordersLastFetch: number;
  contractsLastFetch: number;
}

const DEFAULT_MARKET_VIEW_STATE: MarketViewState = {
  typeTab: "sell",
  status: null,
  ordersLastFetch: 0,
  contractsLastFetch: 0,
};

export const marketViewState = writable<MarketViewState>({ ...DEFAULT_MARKET_VIEW_STATE });
export const marketSelected = writable<Set<string>>(new Set());

/**
 * Mutate `marketSelected` via callback with the `new Set(...)` replacement
 * handled here - in-place Set mutation keeps the reference, so subscribers
 * never fire.
 */
export function mutateMarketSelected(mutator: (s: Set<string>) => void): void {
  marketSelected.update((s) => {
    mutator(s);
    return new Set(s);
  });
}

export function setMarketViewState(patch: Partial<MarketViewState>): void {
  marketViewState.update((state) => ({ ...state, ...patch }));
}

export function resetMarketFetchTimes(): void {
  setMarketViewState({ ordersLastFetch: 0, contractsLastFetch: 0 });
}

export const orderModalState = writable<OrderModalState | null>(null);
