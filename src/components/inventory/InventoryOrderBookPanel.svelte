<script lang="ts">
  import { onDestroy } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import { invoke, send } from "../../lib/ipc.js";
  import { orderModalState } from "../../stores/market.js";
  import {
    clearOrderBookCache,
    fetchItemOrderBookBySlug,
    type ItemOrderBook,
    type OrderBookEntry,
  } from "../../lib/wfm/orderBook.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import type { WfmLookupItem, OrderType } from "../../types/market.js";
  import { normalizeRank, isRankedGroup, MAX_SUPPORTED_RANK } from "../../../config/shared/numeric.js";

  export let item: InventoryViewItem | null = null;

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
  let ageTickTimer: ReturnType<typeof setInterval> | null = null;
  let nowTimestamp = Date.now();
  let onlineIngameOnly = true;
  let sellSort: SideSort = "best";
  let buySort: SideSort = "best";
  let selectedRank = 0;

  function normalizeRankValue(value: unknown): number | null {
    return normalizeRank(value, MAX_SUPPORTED_RANK);
  }

  function defaultMaxRankForGroup(group: InventoryViewItem["inventoryGroup"] | null | undefined): number {
    if (group === "mods") return 10;
    if (group === "arcanes") return 5;
    return 0;
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
    if (ageTickTimer) clearInterval(ageTickTimer);
  });

  function setAgeTick(enabled: boolean): void {
    if (ageTickTimer) {
      clearInterval(ageTickTimer);
      ageTickTimer = null;
    }
    if (!enabled) return;
    ageTickTimer = setInterval(() => {
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

  function rowKey(entry: OrderBookEntry, index: number): string {
    return `${entry.userName}:${entry.rank ?? "na"}:${entry.platinum}:${entry.quantity}:${index}`;
  }

  function statusLabel(status: string | null): string {
    if (status === "ingame") return "In game";
    if (status === "online") return "Online";
    if (status === "offline") return "Offline";
    if (status === "invisible") return "Invisible";
    return "Unknown";
  }

  function statusClass(status: string | null): string {
    if (status === "ingame") return "ingame";
    if (status === "online") return "online";
    if (status === "offline") return "offline";
    if (status === "invisible") return "invisible";
    return "unknown";
  }

  function isActiveStatus(status: string | null): boolean {
    return status === "ingame" || status === "online";
  }

  function filterStatus(entries: OrderBookEntry[], activeOnly: boolean): OrderBookEntry[] {
    if (!activeOnly) return [...entries];
    return entries.filter((entry) => isActiveStatus(entry.status));
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

<aside class="inventory-orderbook-panel">
  <div class="flex justify-between items-center gap-[0.4rem]">
    <h3 class="inventory-orderbook-head-title">Market Listings</h3>
    {#if currentSlug}
      <div class="flex gap-[0.32rem]">
        <button class="btn-secondary btn-sm" on:click={refresh}>Refresh</button>
        <button class="btn-secondary btn-sm" on:click={openOnWarframeMarket}>Open WFM</button>
      </div>
    {/if}
  </div>
  {#if feedbackMessage}
    <div class="inventory-orderbook-feedback">{feedbackMessage}</div>
  {/if}

  {#if !item}
    <div class="inventory-orderbook-empty">Select an item to view WTS/WTB listings.</div>
  {:else}
    <div class="grid grid-cols-[52px_minmax(0,1fr)] gap-[0.55rem] items-center">
      <div class="h-[52px] w-[52px] flex items-center justify-center rounded-[0.45rem] border border-border bg-bg-raised overflow-hidden">
        <ItemImage src={item.displayImageUrl} alt={item.name} />
      </div>
      <div class="inventory-orderbook-item-meta">
        <div class="font-display text-[0.9rem] font-semibold text-text-primary overflow-hidden text-ellipsis whitespace-nowrap">{item.name}</div>
        <div class="text-[0.76rem] text-text-secondary">
          x{item.amount} · {item.categoryLabel}{#if requestRank != null} · Viewing R{requestRank}{/if}
        </div>
      </div>
    </div>

    {#if !currentSlug}
      <div class="inventory-orderbook-empty">No market slug available for this item.</div>
    {:else if loading}
      <div class="inventory-orderbook-loading">Loading listings...</div>
    {:else if errorMessage}
      <div class="inventory-orderbook-error">{errorMessage}</div>
    {:else if noData || !orderBook}
      <div class="inventory-orderbook-empty">No active listings found.</div>
    {:else}
      <div class="inventory-orderbook-summary">
        <div class="inventory-orderbook-stat">
          <span>Best WTS</span>
          <strong>{bestSell != null ? `${bestSell}p` : "-"}</strong>
        </div>
        <div class="inventory-orderbook-stat">
          <span>Best WTB</span>
          <strong>{bestBuy != null ? `${bestBuy}p` : "-"}</strong>
        </div>
        <div class="inventory-orderbook-stat">
          <span>Spread</span>
          <strong>{spread != null ? `${spread}p` : "-"}</strong>
        </div>
        <div class="inventory-orderbook-updated">
          {formatUpdatedLabel(orderBook?.timestamp ?? null, nowTimestamp)}
        </div>
      </div>

      <div class="inventory-orderbook-controls">
        <label class="inline-flex items-center gap-[0.4rem] text-[0.74rem] text-text-secondary select-none">
          <input type="checkbox" class="accent-accent" bind:checked={onlineIngameOnly} />
          <span>Online/In-game only</span>
        </label>
        <div class="grid gap-[0.4rem]">
          {#if isRankedListingItem}
            <label class="inventory-orderbook-sort">
              <span>Rank view</span>
              <select bind:value={selectedRank}>
                {#each rankOptions as rankOption (rankOption)}
                  <option value={rankOption}>R{rankOption}</option>
                {/each}
              </select>
            </label>
          {/if}
          <div class="inventory-orderbook-side-sorters">
            <label class="inventory-orderbook-sort">
              <span>WTS sort</span>
              <select bind:value={sellSort}>
                {#each SELL_SORT_OPTIONS as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
            <label class="inventory-orderbook-sort">
              <span>WTB sort</span>
              <select bind:value={buySort}>
                {#each BUY_SORT_OPTIONS as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          </div>
        </div>
      </div>

      <div class="inventory-orderbook-post-actions">
        <button class="btn-secondary btn-sm" on:click={() => void openPostOrder("sell")}>Post WTS</button>
        <button class="btn-secondary btn-sm" on:click={() => void openPostOrder("buy")}>Post WTB</button>
      </div>

      <div class="inventory-orderbook-columns">
        <section class="inventory-orderbook-side inventory-orderbook-side-sell">
          <header>
            <span>WTS</span>
          </header>
          {#if sellRows.length === 0}
            <div class="inventory-orderbook-side-empty">No sell orders</div>
          {:else}
            <div class="inventory-orderbook-rows">
              {#each sellRows as entry, index (rowKey(entry, index))}
                <div class="inventory-orderbook-row">
                  <div class="inventory-orderbook-row-head">
                    <div class="inventory-orderbook-user-block">
                      <span class="overflow-hidden text-ellipsis whitespace-nowrap text-[0.76rem] text-text-primary" title={entry.userName}>{entry.userName}</span>
                      {#if isRankedListingItem}
                        <span class="inventory-orderbook-rank-sub text-[0.62rem] text-text-muted font-display tracking-[0.03em] uppercase"
                          >{entry.rank != null ? `R${entry.rank}` : "R?"}</span
                        >
                      {/if}
                    </div>
                    <span class={`inventory-orderbook-status inventory-orderbook-status-${statusClass(entry.status)}`}>
                      {statusLabel(entry.status)}
                    </span>
                    <span class="inventory-orderbook-qty">x{entry.quantity}</span>
                    <span class="inventory-orderbook-plat">{entry.platinum}p</span>
                  </div>
                  <div class="flex gap-[0.32rem]">
                    <button class="btn-secondary btn-sm inventory-orderbook-row-btn" on:click={() => copyWhisper(entry, "sell")}>
                      Whisper
                    </button>
                    <button class="btn-secondary btn-sm inventory-orderbook-row-btn" on:click={() => openSellerProfile(entry)}>
                      Profile
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="inventory-orderbook-side inventory-orderbook-side-buy">
          <header>
            <span>WTB</span>
          </header>
          {#if buyRows.length === 0}
            <div class="inventory-orderbook-side-empty">No buy orders</div>
          {:else}
            <div class="inventory-orderbook-rows">
              {#each buyRows as entry, index (rowKey(entry, index))}
                <div class="inventory-orderbook-row">
                  <div class="inventory-orderbook-row-head">
                    <div class="inventory-orderbook-user-block">
                      <span class="overflow-hidden text-ellipsis whitespace-nowrap text-[0.76rem] text-text-primary" title={entry.userName}>{entry.userName}</span>
                      {#if isRankedListingItem}
                        <span class="inventory-orderbook-rank-sub text-[0.62rem] text-text-muted font-display tracking-[0.03em] uppercase"
                          >{entry.rank != null ? `R${entry.rank}` : "R?"}</span
                        >
                      {/if}
                    </div>
                    <span class={`inventory-orderbook-status inventory-orderbook-status-${statusClass(entry.status)}`}>
                      {statusLabel(entry.status)}
                    </span>
                    <span class="inventory-orderbook-qty">x{entry.quantity}</span>
                    <span class="inventory-orderbook-plat">{entry.platinum}p</span>
                  </div>
                  <div class="flex gap-[0.32rem]">
                    <button class="btn-secondary btn-sm inventory-orderbook-row-btn" on:click={() => copyWhisper(entry, "buy")}>
                      Whisper
                    </button>
                    <button class="btn-secondary btn-sm inventory-orderbook-row-btn" on:click={() => openSellerProfile(entry)}>
                      Profile
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
  {/if}
</aside>

<style>
  .inventory-orderbook-panel {
    position: sticky; top: 0.65rem; border: 1px solid var(--border);
    border-radius: 0.625rem; background: var(--bg-surface); padding: 0.62rem;
    display: flex; flex-direction: column; gap: 0.58rem;
  }
  .inventory-orderbook-head-title {
    margin: 0; font-family: var(--font-display); font-size: 0.94rem; color: var(--text-primary);
  }
  .inventory-orderbook-loading,
  .inventory-orderbook-empty,
  .inventory-orderbook-error,
  .inventory-orderbook-side-empty {
    font-size: 0.78rem; color: var(--text-secondary);
    border: 1px dashed var(--border); border-radius: 0.45rem;
    background: var(--bg-soft); padding: 0.5rem 0.55rem;
  }
  .inventory-orderbook-feedback {
    font-size: 0.76rem; color: var(--accent-bright);
    border: 1px solid color-mix(in oklab, var(--accent) 42%, transparent);
    border-radius: 0.45rem;
    background: color-mix(in oklab, var(--accent) 14%, var(--bg-soft));
    padding: 0.44rem 0.55rem;
  }
  .inventory-orderbook-error { color: var(--danger); border-color: rgba(248, 113, 113, 0.4); }
  .inventory-orderbook-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.36rem; }
  .inventory-orderbook-stat {
    border: 1px solid var(--border); border-radius: 0.45rem;
    background: var(--bg-soft); padding: 0.35rem 0.45rem; display: grid; gap: 0.16rem;
  }
  .inventory-orderbook-stat span { font-size: 0.66rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .inventory-orderbook-stat strong { font-family: var(--font-display); font-size: 0.8rem; color: var(--text-primary); }
  .inventory-orderbook-updated { grid-column: 1 / -1; font-size: 0.72rem; color: var(--text-muted); text-align: right; }
  .inventory-orderbook-controls {
    border: 1px solid var(--border); border-radius: 0.5rem;
    background: color-mix(in oklab, var(--bg-surface) 84%, var(--bg-raised));
    padding: 0.45rem; display: grid; gap: 0.42rem;
  }
  .inventory-orderbook-side-sorters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.4rem; }
  .inventory-orderbook-sort { display: grid; gap: 0.2rem; }
  .inventory-orderbook-sort span { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .inventory-orderbook-sort select {
    width: 100%; border: 1px solid var(--border); border-radius: 0.38rem;
    background: var(--bg-raised); color: var(--text-primary); padding: 0.26rem 0.34rem; font-size: 0.72rem;
  }
  .inventory-orderbook-sort select:focus {
    outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 30%, transparent);
  }
  .inventory-orderbook-post-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.38rem; }
  .inventory-orderbook-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
  .inventory-orderbook-side {
    border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden;
    background: color-mix(in oklab, var(--bg-surface) 82%, var(--bg-raised));
  }
  .inventory-orderbook-side header {
    display: flex; justify-content: center; align-items: center;
    padding: 0.32rem 0.4rem; font-family: var(--font-display);
    font-size: 0.75rem; font-weight: 700; letter-spacing: 0.03em;
  }
  .inventory-orderbook-side-sell header { background: rgba(185, 28, 28, 0.2); color: #fda4af; border-bottom: 1px solid rgba(251, 113, 133, 0.25); }
  .inventory-orderbook-side-buy header { background: rgba(6, 95, 70, 0.2); color: #86efac; border-bottom: 1px solid rgba(52, 211, 153, 0.24); }
  .inventory-orderbook-rows { display: grid; }
  .inventory-orderbook-row {
    display: grid; gap: 0.32rem; padding: 0.35rem 0.45rem;
    border-top: 1px solid color-mix(in oklab, var(--border) 72%, transparent);
  }
  .inventory-orderbook-row:first-child { border-top: 0; }
  .inventory-orderbook-row-head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 0.3rem; align-items: center; }
  .inventory-orderbook-user-block { display: grid; gap: 0.08rem; min-width: 0; }
  .inventory-orderbook-row-btn { flex: 1; min-height: 1.7rem; padding: 0.24rem 0.46rem; font-size: 0.66rem; }
  .inventory-orderbook-status {
    border-radius: 999px; border: 1px solid var(--border); padding: 0.1rem 0.38rem;
    font-size: 0.62rem; font-family: var(--font-display); letter-spacing: 0.03em;
    text-transform: uppercase; white-space: nowrap;
  }
  .inventory-orderbook-status-ingame { border-color: rgba(74, 222, 128, 0.45); background: rgba(34, 197, 94, 0.16); color: #86efac; }
  .inventory-orderbook-status-online { border-color: rgba(147, 197, 253, 0.45); background: rgba(59, 130, 246, 0.16); color: #bfdbfe; }
  .inventory-orderbook-status-offline { border-color: rgba(148, 163, 184, 0.4); background: rgba(51, 65, 85, 0.26); color: #cbd5e1; }
  .inventory-orderbook-status-invisible { border-color: rgba(251, 191, 36, 0.42); background: rgba(161, 98, 7, 0.24); color: #fde68a; }
  .inventory-orderbook-status-unknown { border-color: rgba(148, 163, 184, 0.45); background: rgba(71, 85, 105, 0.24); color: #cbd5e1; }
  .inventory-orderbook-qty,
  .inventory-orderbook-plat { font-family: var(--font-display); font-size: 0.74rem; color: var(--text-secondary); }
  .inventory-orderbook-plat { text-align: right; color: var(--accent-bright); font-weight: 700; }

  @media (max-width: 1100px) { .inventory-orderbook-panel { position: static; } }
  @media (max-width: 800px) {
    .inventory-orderbook-columns { grid-template-columns: 1fr; }
    .inventory-orderbook-side-sorters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .inventory-orderbook-post-actions { grid-template-columns: 1fr; }
    .inventory-orderbook-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .inventory-orderbook-updated { text-align: left; }
    .inventory-orderbook-row-head {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "user status" "qty price";
    }
    .inventory-orderbook-user-block { grid-area: user; }
    .inventory-orderbook-status { grid-area: status; justify-self: end; }
    .inventory-orderbook-qty { grid-area: qty; }
    .inventory-orderbook-plat { grid-area: price; }
  }
</style>
