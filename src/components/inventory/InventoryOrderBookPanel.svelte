<script lang="ts">
  import { onDestroy } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import InventoryOrderBookSide from "./InventoryOrderBookSide.svelte";
  import { invoke, send } from "../../lib/ipc.js";
  import { useInterval } from "../../lib/timers.js";
  import { orderModalState } from "../../stores/market.js";
  import {
    clearOrderBookCache,
    fetchItemOrderBookBySlug,
    type ItemOrderBook,
    type OrderBookEntry,
  } from "../../lib/wfm/orderBook.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import type { WfmLookupItem, OrderType } from "../../types/market.js";
  import {
    normalizeRank,
    isRankedGroup,
    MAX_SUPPORTED_RANK,
    resolveRankedMaxRank,
  } from "../../../config/shared/numeric.js";
  import { isActiveOrderStatus } from "../../../config/shared/wfmOrders.js";

  export let item: InventoryViewItem | null = null;
  export let onClose: (() => void) | null = null;

  type OrderSide = OrderType;
  type SideSort = "best" | "price_low" | "price_high" | "quantity_high" | "name_asc";

  const SELL_SORT_OPTIONS: Array<{ value: SideSort; label: string }> = [
    { value: "best", label: "Best price" },
    { value: "price_high", label: "Price high to low" },
    { value: "quantity_high", label: "Quantity high to low" },
    { value: "name_asc", label: "Name A to Z" },
  ];

  const BUY_SORT_OPTIONS: Array<{ value: SideSort; label: string }> = [
    { value: "best", label: "Best offer" },
    { value: "price_low", label: "Price low to high" },
    { value: "quantity_high", label: "Quantity high to low" },
    { value: "name_asc", label: "Name A to Z" },
  ];

  const AUTO_REFRESH_MS = 45_000;
  const FEEDBACK_TTL_MS = 2_500;
  const DISPLAY_ROWS_PER_SIDE = 20;

  let currentSlug: string | null = null;
  let currentRankFilter: number | null = null;
  let orderBook: ItemOrderBook | null = null;
  let loading = false;
  let errorMessage = "";
  let feedbackMessage = "";
  let noData = false;
  let requestToken = 0;
  let autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let stopAgeTick: (() => void) | null = null;
  let nowTimestamp = Date.now();
  let onlineIngameOnly = true;
  let sellSort: SideSort = "best";
  let buySort: SideSort = "best";
  let selectedRank = 0;

  function normalizeRankValue(value: unknown): number | null {
    return normalizeRank(value, MAX_SUPPORTED_RANK);
  }

  function defaultMaxRankForGroup(group: InventoryViewItem["inventoryGroup"] | null | undefined): number {
    return resolveRankedMaxRank(group);
  }

  const didItemKeyChange = (() => {
    let previous = "";
    return (next: string): boolean => {
      if (next === previous) return false;
      previous = next;
      return true;
    };
  })();

  const didRequestKeyChange = (() => {
    let previous: string | null = null;
    return (next: string | null): boolean => {
      if (next === previous) return false;
      previous = next;
      return true;
    };
  })();

  $: isRankedListingItem = isRankedGroup(item?.inventoryGroup);
  $: itemRankValue = normalizeRankValue(item?.rank);
  $: itemMaxRankValue = normalizeRankValue(item?.maxRank);
  $: maxSelectableRank = isRankedListingItem
    ? Math.max(0, itemMaxRankValue ?? defaultMaxRankForGroup(item?.inventoryGroup))
    : 0;
  $: rankOptions = isRankedListingItem
    ? Array.from({ length: Math.max(1, maxSelectableRank + 1) }, (_, idx) => idx)
    : [];

  $: itemKey = item
    ? `${item.internalName}:${item.rank}:${item.maxRank}:${item.inventoryGroup}`
    : "";
  $: if (didItemKeyChange(itemKey)) {
    if (isRankedListingItem && item) {
      const defaultRank = itemRankValue ?? 0;
      selectedRank = Math.max(0, Math.min(defaultRank, maxSelectableRank));
    } else {
      selectedRank = 0;
    }
  }

  $: {
    const normalized = normalizeRankValue(selectedRank);
    const bounded = Math.max(0, Math.min(normalized ?? 0, maxSelectableRank));
    if (bounded !== selectedRank) {
      selectedRank = bounded;
    }
  }

  $: requestRank = isRankedListingItem ? normalizeRankValue(selectedRank) ?? 0 : null;

  $: filteredSellBase = filterStatus(orderBook?.sell ?? [], onlineIngameOnly);
  $: filteredBuyBase = filterStatus(orderBook?.buy ?? [], onlineIngameOnly);
  $: bestSell = filteredSellBase.length > 0 ? Math.min(...filteredSellBase.map((entry) => entry.platinum)) : null;
  $: bestBuy = filteredBuyBase.length > 0 ? Math.max(...filteredBuyBase.map((entry) => entry.platinum)) : null;
  $: spread = bestSell != null && bestBuy != null ? bestSell - bestBuy : null;
  $: sellRows = sortEntries(filteredSellBase, "sell", sellSort).slice(0, DISPLAY_ROWS_PER_SIDE);
  $: buyRows = sortEntries(filteredBuyBase, "buy", buySort).slice(0, DISPLAY_ROWS_PER_SIDE);

  $: slug = item?.marketSlug || null;
  $: requestKey = slug ? `${slug}|${requestRank == null ? "all" : `r${requestRank}`}` : null;
  $: if (didRequestKeyChange(requestKey)) {
    currentSlug = slug;
    currentRankFilter = requestRank;
    resetAutoRefresh(null, null);
    void load(currentSlug, currentRankFilter);
  }

  onDestroy(() => {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    stopAgeTick?.();
  });

  function setAgeTick(enabled: boolean): void {
    stopAgeTick?.();
    stopAgeTick = null;
    if (!enabled) return;
    stopAgeTick = useInterval(() => {
      nowTimestamp = Date.now();
    }, 1_000);
  }

  function resetAutoRefresh(nextSlug: string | null, nextRank: number | null): void {
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (!nextSlug) return;
    autoRefreshTimer = setTimeout(() => {
      if (nextSlug !== currentSlug) return;
      if (nextRank !== currentRankFilter) return;
      clearOrderBookCache(nextSlug, nextRank);
      void load(nextSlug, nextRank);
    }, AUTO_REFRESH_MS);
  }

  async function load(slugToLoad: string | null, rankToLoad: number | null): Promise<void> {
    const token = ++requestToken;

    orderBook = null;
    errorMessage = "";
    noData = false;

    if (!slugToLoad) {
      loading = false;
      setAgeTick(false);
      return;
    }

    loading = true;

    let result = await fetchItemOrderBookBySlug(slugToLoad, { rank: rankToLoad });
    if (result.status === "error") {
      clearOrderBookCache(slugToLoad, rankToLoad);
      result = await fetchItemOrderBookBySlug(slugToLoad, { rank: rankToLoad });
    }
    if (token !== requestToken) return;

    loading = false;
    if (result.status === "ok") {
      orderBook = result.data;
      nowTimestamp = Date.now();
      setAgeTick(true);
      resetAutoRefresh(slugToLoad, rankToLoad);
      return;
    }
    if (result.status === "not_found") {
      setAgeTick(false);
      noData = true;
      resetAutoRefresh(slugToLoad, rankToLoad);
      return;
    }
    setAgeTick(false);
    resetAutoRefresh(slugToLoad, rankToLoad);
    errorMessage = "Failed to load listings. Try again.";
  }

  function setFeedback(message: string): void {
    feedbackMessage = message;
    if (feedbackTimer) {
      clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
    if (!message) return;
    feedbackTimer = setTimeout(() => {
      feedbackMessage = "";
      feedbackTimer = null;
    }, FEEDBACK_TTL_MS);
  }

  function refresh(): void {
    if (!currentSlug) return;
    clearOrderBookCache(currentSlug, currentRankFilter);
    void load(currentSlug, currentRankFilter);
  }

  function openOnWarframeMarket(): void {
    if (!currentSlug) return;
    send("open-external", `https://warframe.market/items/${currentSlug}`);
  }

  function filterStatus(entries: OrderBookEntry[], activeOnly: boolean): OrderBookEntry[] {
    if (!activeOnly) return [...entries];
    return entries.filter((entry) => isActiveOrderStatus(entry.status));
  }

  function compareBestSide(a: OrderBookEntry, b: OrderBookEntry, side: OrderSide): number {
    if (a.platinum !== b.platinum) {
      return side === "sell" ? a.platinum - b.platinum : b.platinum - a.platinum;
    }
    if (a.quantity !== b.quantity) {
      return b.quantity - a.quantity;
    }
    return a.userName.localeCompare(b.userName);
  }

  function sortEntries(entries: OrderBookEntry[], side: OrderSide, mode: SideSort): OrderBookEntry[] {
    const rows = [...entries];
    rows.sort((a, b) => {
      if (mode === "best") {
        return compareBestSide(a, b, side);
      }

      if (mode === "price_low") {
        if (a.platinum !== b.platinum) return a.platinum - b.platinum;
        return b.quantity - a.quantity;
      }

      if (mode === "price_high") {
        if (a.platinum !== b.platinum) return b.platinum - a.platinum;
        return b.quantity - a.quantity;
      }

      if (mode === "quantity_high") {
        if (a.quantity !== b.quantity) return b.quantity - a.quantity;
        return compareBestSide(a, b, side);
      }

      return a.userName.localeCompare(b.userName);
    });
    return rows;
  }

  function formatUpdatedLabel(timestamp: number | null | undefined, nowMs: number): string {
    if (!timestamp || timestamp <= 0) return "Updated recently";
    const ageSec = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
    if (ageSec < 5) return "Updated just now";
    if (ageSec < 60) return `Updated ${ageSec}s ago`;
    const ageMin = Math.floor(ageSec / 60);
    if (ageMin < 60) return `Updated ${ageMin}m ago`;
    const ageHr = Math.floor(ageMin / 60);
    return `Updated ${ageHr}h ago`;
  }

  function buildWhisper(entry: OrderBookEntry, side: OrderSide): string {
    if (!item) return "";
    const quantitySuffix = entry.quantity > 1 ? ` x${entry.quantity}` : "";
    const rankSuffix = isRankedListingItem ? ` (Rank ${entry.rank ?? 0})` : "";
    const itemText = `${item.name}${rankSuffix}${quantitySuffix}`;
    if (side === "sell") {
      return `/w ${entry.userName} Hi! I want to buy: ${itemText} for ${entry.platinum} platinum.`;
    }
    return `/w ${entry.userName} Hi! I want to sell: ${itemText} for ${entry.platinum} platinum.`;
  }

  async function copyWhisper(entry: OrderBookEntry, side: OrderSide): Promise<void> {
    const message = buildWhisper(entry, side);
    if (!message) return;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
        setFeedback("Whisper copied.");
        return;
      }
      setFeedback("Clipboard unavailable in this environment.");
    } catch {
      setFeedback("Failed to copy whisper.");
    }
  }

  function openSellerProfile(entry: OrderBookEntry): void {
    send("open-external", `https://warframe.market/profile/${encodeURIComponent(entry.userName)}`);
  }

  function isLookupError(value: unknown): value is { error: string } {
    return (
      typeof value === "object" &&
      value != null &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "string"
    );
  }

  function isLookupItem(value: unknown): value is WfmLookupItem {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      row.id.trim().length > 0 &&
      typeof row.item_name === "string" &&
      row.item_name.trim().length > 0 &&
      typeof row.url_name === "string" &&
      row.url_name.trim().length > 0
    );
  }

  async function openPostOrder(orderType: "sell" | "buy"): Promise<void> {
    if (!currentSlug) return;

    const session = await invoke("wfmGetSession");
    if (!session.loggedIn) {
      setFeedback("Sign in on the Market tab first.");
      return;
    }

    const lookup = await invoke("wfmLookupItemBySlug", currentSlug);
    if (isLookupError(lookup)) {
      setFeedback(lookup.error || "Unable to prepare order for this item.");
      return;
    }
    if (!isLookupItem(lookup)) {
      setFeedback("Unable to prepare order for this item.");
      return;
    }

    orderModalState.set({
      mode: "create",
      order: null,
      draft: {
        item: lookup,
        orderType,
        modRank: requestRank,
      },
    });
  }
</script>

<aside class="sticky top-2.5 flex flex-col gap-2.5 rounded-lg border border-border bg-bg-surface p-2.5 max-[1100px]:static">
  <div class="flex justify-between items-center gap-1.5">
    <h3 class="m-0 font-display text-base text-text-primary">Market Listings</h3>
    <div class="flex gap-1.5">
      {#if currentSlug}
        <button class="btn-secondary btn-sm" on:click={refresh}>Refresh</button>
        <button class="btn-secondary btn-sm" on:click={openOnWarframeMarket}>Open WFM</button>
      {/if}
      {#if onClose}
        <button class="btn-secondary btn-sm !px-2" aria-label="Close market listings" title="Close" on:click={onClose}>&times;</button>
      {/if}
    </div>
  </div>
  {#if feedbackMessage}
    <div class="inventory-orderbook-feedback">{feedbackMessage}</div>
  {/if}

  {#if !item}
    <div class="rounded-lg border border-dashed border-border bg-bg-soft px-2 py-2 text-xs text-text-secondary">Select an item to view WTS/WTB listings.</div>
  {:else}
    <div class="grid grid-cols-[52px_minmax(0,1fr)] gap-2 items-center">
      <div class="h-[52px] w-[52px] flex items-center justify-center rounded-lg border border-border bg-bg-raised overflow-hidden">
        <ItemImage src={item.displayImageUrl} alt={item.name} />
      </div>
      <div class="inventory-orderbook-item-meta">
        <div class="font-display text-sm font-semibold text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">{item.name}</div>
        <div class="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            x{item.amount} · {item.categoryLabel}{#if requestRank != null} · Viewing R{requestRank}{/if}
          </span>
          {#if orderBook && !loading && !errorMessage && !noData}
            <span class="shrink-0 text-text-muted">{formatUpdatedLabel(orderBook.timestamp ?? null, nowTimestamp)}</span>
          {/if}
        </div>
      </div>
    </div>

    {#if !currentSlug}
      <div class="rounded-lg border border-dashed border-border bg-bg-soft px-2 py-2 text-xs text-text-secondary">No market slug available for this item.</div>
    {:else if loading}
      <div class="rounded-lg border border-dashed border-border bg-bg-soft px-2 py-2 text-xs text-text-secondary">Loading listings...</div>
    {:else if errorMessage}
      <div class="rounded-lg border border-dashed border-[rgba(248,113,113,0.4)] bg-bg-soft px-2 py-2 text-xs text-danger">{errorMessage}</div>
    {:else if noData || !orderBook}
      <div class="rounded-lg border border-dashed border-border bg-bg-soft px-2 py-2 text-xs text-text-secondary">No active listings found.</div>
    {:else}
      <div class="grid grid-cols-3 gap-1.5 max-[800px]:grid-cols-2">
        <div class="grid gap-0.5 rounded-lg border border-border bg-bg-soft px-2 py-1.5">
          <span class="text-xs uppercase tracking-[0.05em] text-text-muted">Best WTS</span>
          <strong class="font-display text-xs text-text-primary">{bestSell != null ? `${bestSell}p` : "-"}</strong>
        </div>
        <div class="grid gap-0.5 rounded-lg border border-border bg-bg-soft px-2 py-1.5">
          <span class="text-xs uppercase tracking-[0.05em] text-text-muted">Best WTB</span>
          <strong class="font-display text-xs text-text-primary">{bestBuy != null ? `${bestBuy}p` : "-"}</strong>
        </div>
        <div class="grid gap-0.5 rounded-lg border border-border bg-bg-soft px-2 py-1.5">
          <span class="text-xs uppercase tracking-[0.05em] text-text-muted">Spread</span>
          <strong class="font-display text-xs text-text-primary">{spread != null ? `${spread}p` : "-"}</strong>
        </div>
      </div>

      <div class="grid gap-1.5 rounded-lg border border-border bg-[color-mix(in_oklab,var(--bg-surface)_84%,var(--bg-raised))] p-2">
        <label class="inline-flex items-center gap-1.5 text-xs text-text-secondary select-none">
          <input type="checkbox" class="accent-accent" bind:checked={onlineIngameOnly} />
          <span>Online/In-game only</span>
        </label>
        <div class="grid gap-1.5">
          {#if isRankedListingItem}
            <label class="grid gap-1">
              <span class="text-xs uppercase tracking-[0.05em] text-text-muted">Rank view</span>
              <select class="inventory-orderbook-select" bind:value={selectedRank}>
                {#each rankOptions as rankOption (rankOption)}
                  <option value={rankOption}>R{rankOption}</option>
                {/each}
              </select>
            </label>
          {/if}
          <div class="grid grid-cols-2 gap-1.5">
            <label class="grid gap-1">
              <span class="text-xs uppercase tracking-[0.05em] text-text-muted">WTS sort</span>
              <select class="inventory-orderbook-select" bind:value={sellSort}>
                {#each SELL_SORT_OPTIONS as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
            <label class="grid gap-1">
              <span class="text-xs uppercase tracking-[0.05em] text-text-muted">WTB sort</span>
              <select class="inventory-orderbook-select" bind:value={buySort}>
                {#each BUY_SORT_OPTIONS as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-1.5 max-[800px]:grid-cols-1">
        <button class="btn-secondary btn-sm" on:click={() => void openPostOrder("sell")}>Post WTS</button>
        <button class="btn-secondary btn-sm" on:click={() => void openPostOrder("buy")}>Post WTB</button>
      </div>

      <div class="grid grid-cols-2 gap-2 max-[800px]:grid-cols-1">
        <InventoryOrderBookSide
          side="sell"
          rows={sellRows}
          {isRankedListingItem}
          {copyWhisper}
          {openSellerProfile}
        />
        <InventoryOrderBookSide
          side="buy"
          rows={buyRows}
          {isRankedListingItem}
          {copyWhisper}
          {openSellerProfile}
        />
      </div>
    {/if}
  {/if}
</aside>

<style>
  .inventory-orderbook-feedback {
    font-size: 0.76rem; color: var(--accent-bright);
    border: 1px solid color-mix(in oklab, var(--accent) 42%, transparent);
    border-radius: 0.45rem;
    background: color-mix(in oklab, var(--accent) 14%, var(--bg-soft));
    padding: 0.44rem 0.55rem;
  }
  .inventory-orderbook-select {
    width: 100%; border: 1px solid var(--border); border-radius: 0.38rem;
    background: var(--bg-raised); color: var(--text-primary); padding: 0.26rem 0.34rem; font-size: 0.72rem;
  }
  .inventory-orderbook-select:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 30%, transparent);
  }
</style>
