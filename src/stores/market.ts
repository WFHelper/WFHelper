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

/**
 * Mutate `marketSelected` through a callback and have the replacement
 * `new Set(...)` handled for you. Svelte stores only notify subscribers
 * when the reference changes; mutating the Set in place (e.g. `s.add(x);
 * return s;`) silently breaks reactivity. Routing every mutation through
 * this helper makes that mistake impossible.
 */
export function mutateMarketSelected(mutator: (s: Set<string>) => void): void {
  marketSelected.update((s) => {
    mutator(s);
    return new Set(s);
  });
}
export const marketOrdersLastFetch = writable<number>(0);
export const marketContractsLastFetch = writable<number>(0);
export const orderModalState = writable<OrderModalState | null>(null);
