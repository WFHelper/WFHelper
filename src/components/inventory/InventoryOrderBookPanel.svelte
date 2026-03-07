<script lang="ts">
  import { onDestroy } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import { ipc } from "../../lib/ipc.js";
  import { orderModalState } from "../../stores/market.js";
  import {
    clearOrderBookCache,
    fetchItemOrderBookBySlug,
    type ItemOrderBook,
    type OrderBookEntry,
  } from "../../lib/wfm/orderBook.js";
  import type { InventoryViewItem } from "../../lib/inventoryMarket.js";
  import type { WfmLookupItem } from "../../types/market.js";
  import sharedNumeric from "../../../config/shared/numeric.cjs";

  const { normalizeRank, isRankedGroup, MAX_SUPPORTED_RANK } = sharedNumeric as {
    normalizeRank: (value: unknown, maxRank?: number) => number | null;
    isRankedGroup: (group: string | null | undefined) => boolean;
    MAX_SUPPORTED_RANK: number;
  };

  export let item: InventoryViewItem | null = null;

  type OrderSide = "sell" | "buy";
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
    ipc.openExternal(`https://warframe.market/items/${currentSlug}`);
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
    ipc.openExternal(`https://warframe.market/profile/${encodeURIComponent(entry.userName)}`);
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

    const session = await ipc.wfmGetSession();
    if (!session.loggedIn) {
      setFeedback("Sign in on the Market tab first.");
      return;
    }

    const lookup = await ipc.wfmLookupItemBySlug(currentSlug);
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
  <div class="inventory-orderbook-head">
    <h3>Market Listings</h3>
    {#if currentSlug}
      <div class="inventory-orderbook-actions">
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
    <div class="inventory-orderbook-item">
      <div class="inventory-orderbook-item-image">
        <ItemImage src={item.displayImageUrl} alt={item.name} />
      </div>
      <div class="inventory-orderbook-item-meta">
        <div class="inventory-orderbook-item-name">{item.name}</div>
        <div class="inventory-orderbook-item-sub">
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
        <label class="inventory-orderbook-toggle">
          <input type="checkbox" bind:checked={onlineIngameOnly} />
          <span>Online/In-game only</span>
        </label>
        <div class="inventory-orderbook-sorters">
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
                      <span class="inventory-orderbook-user" title={entry.userName}>{entry.userName}</span>
                      {#if isRankedListingItem}
                        <span class="inventory-orderbook-rank-sub"
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
                  <div class="inventory-orderbook-row-actions">
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
                      <span class="inventory-orderbook-user" title={entry.userName}>{entry.userName}</span>
                      {#if isRankedListingItem}
                        <span class="inventory-orderbook-rank-sub"
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
                  <div class="inventory-orderbook-row-actions">
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
