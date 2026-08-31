import { writable } from "svelte/store";
import { readStorage, writeStorage } from "../lib/persistence.js";
import type {
  MarketTab,
  OrderModalState,
  WfmContractsResult,
  WfmOrder,
  WfmOrdersResult,
  WfmSession,
  WfmStatus,
} from "../types/market.js";

const MARKET_TAB_KEY = "wf_market_tab";
const MARKET_TABS: readonly MarketTab[] = ["sell", "buy", "rivens", "browse", "alerts"];

function restoreMarketTab(): MarketTab {
  const raw = readStorage(MARKET_TAB_KEY);
  return raw && (MARKET_TABS as readonly string[]).includes(raw) ? (raw as MarketTab) : "sell";
}

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
  /** Epoch ms the status drops to invisible; null while it is held indefinitely. */
  statusExpiresAt: number | null;
  /** True while Warframe running is driving the status instead of the user. */
  statusAutoActive: boolean;
  ordersLastFetch: number;
  contractsLastFetch: number;
}

const DEFAULT_MARKET_VIEW_STATE: MarketViewState = {
  typeTab: restoreMarketTab(),
  status: null,
  statusExpiresAt: null,
  statusAutoActive: false,
  ordersLastFetch: 0,
  contractsLastFetch: 0,
};

export const marketViewState = writable<MarketViewState>({ ...DEFAULT_MARKET_VIEW_STATE });
export const marketSelected = writable<Set<string>>(new Set());

/** Replace the Set after mutation so Svelte notifies subscribers. */
export function mutateMarketSelected(mutator: (s: Set<string>) => void): void {
  marketSelected.update((s) => {
    mutator(s);
    return new Set(s);
  });
}

export function setMarketViewState(patch: Partial<MarketViewState>): void {
  if (patch.typeTab) writeStorage(MARKET_TAB_KEY, patch.typeTab);
  marketViewState.update((state) => ({ ...state, ...patch }));
}

// The token lives with the store because zeroing the freshness stamp has to
// retire in-flight page walks too, and those are driven from lib/.
let contractsWriteToken = 0;

/** Claims the contracts store for a request that has not sent yet. */
export function reserveContractsWrite(): number {
  contractsWriteToken += 1;
  return contractsWriteToken;
}

export function isCurrentContractsWrite(token: number): boolean {
  return token === contractsWriteToken;
}

/** Drops the contracts freshness mark and every reservation taken before now. */
export function invalidateContractsFreshness(): void {
  contractsWriteToken += 1;
  setMarketViewState({ contractsLastFetch: 0 });
}

export function resetMarketFetchTimes(): void {
  contractsWriteToken += 1;
  setMarketViewState({ ordersLastFetch: 0, contractsLastFetch: 0 });
}

export function clearMarketAccountState(): void {
  marketSession.set({ loggedIn: false, userName: null, platform: "pc" });
  marketOrders.set({ sell: [], buy: [] });
  marketContracts.set({ contracts: [], page: 1, totalPages: null, hasMore: false });
  marketSelected.set(new Set());
  resetMarketFetchTimes();
}

function dropClosedQuantity(entries: WfmOrder[], orderId: string, quantity: number): WfmOrder[] {
  return entries.flatMap((entry) => {
    if (entry.id !== orderId) return [entry];
    const remaining = (entry.quantity ?? 0) - quantity;
    return remaining > 0 ? [{ ...entry, quantity: remaining }] : [];
  });
}

/** Reflect WFM closures now; the next fetch corrects local quantity guesses. */
export function applyClosedWfmListing(match: {
  kind: "order" | "contract";
  orderId: string;
  quantity: number;
}): void {
  if (!match.orderId) return;

  if (match.kind === "contract") {
    marketContracts.update((state) => ({
      ...state,
      contracts: state.contracts.filter((contract) => contract.id !== match.orderId),
    }));
  } else {
    marketOrders.update((state) => ({
      sell: dropClosedQuantity(state.sell, match.orderId, match.quantity),
      buy: dropClosedQuantity(state.buy, match.orderId, match.quantity),
    }));
  }

  mutateMarketSelected((selected) => {
    selected.delete(match.orderId);
  });
  resetMarketFetchTimes();
}

export const orderModalState = writable<OrderModalState | null>(null);
