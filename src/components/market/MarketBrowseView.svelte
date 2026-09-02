<script lang="ts">
  import { onDestroy } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";

  import ItemImage from "../ItemImage.svelte";
  import MarketBrowseStats from "./MarketBrowseStats.svelte";
  import WikiButton from "../WikiButton.svelte";
  import { itemLabel } from "../../lib/itemLabel.js";
  import { componentOwnership, itemDb, parsedItems, wfmItems } from "../../stores/data.js";
  import { activeItem } from "../../stores/modals.js";
  import { orderModalState } from "../../stores/market.js";
  import { addSavedSearch, removeSavedSearch, savedSearches } from "../../stores/savedSearches.js";
  import { buildParsedItemFromDb } from "../../lib/parsedItemFromDb.js";
  import { CREDITS_ICON_URL } from "../../lib/assetUrls.js";
  import { invoke, send } from "../../lib/ipc.js";
  import { isIpcError } from "../../lib/ipcGuards.js";
  import { locale, tr as translate, type MessageKey, type Translator } from "../../lib/i18n.js";
  import { useInterval } from "../../lib/timers.js";
  import {
    clearOrderBookCache,
    fetchItemOrderBookBySlug,
    type ItemOrderBook,
    type OrderBookEntry,
  } from "../../lib/wfm/orderBook.js";
  import { formatWfmAssetUrl, titleFromSlug, WFM_HEADERS } from "../../../config/shared/wfm.js";
  import type { WfmItemsLookup } from "../../types/ipc.js";
  import type { ParsedItem } from "../../types/inventory.js";
  import type { WfmLookupItem } from "../../types/market.js";

  interface BrowseItem {
    name: string;
    slug: string;
    thumb: string | null;
    gameRef: string | null;
    maxRank: number | null;
  }

  type BrowseSide = "sell" | "buy";
  type ContentView = "orders" | "stats";
  type StatusFilter = "all" | "onsite" | "ingame";
  type RankFilter = "all" | "maxed";
  const SUGGESTION_LIST_ID = "browse-suggestion-list";
  const AUTO_REFRESH_MS = 45_000;
  const FEEDBACK_TTL_MS = 2_500;
  const MAX_SUGGESTIONS = 8;
  const MAX_ROWS = 50;

  let query = "";
  let showSuggestions = false;
  let activeSuggestion = 0;
  let suggestionEls: HTMLElement[] = [];
  let searchEl: HTMLInputElement | null = null;
  let selected: BrowseItem | null = null;
  let rowLimit = MAX_ROWS;
  let orderBook: ItemOrderBook | null = null;
  let loading = false;
  let errorKey: MessageKey | null = null;
  let noData = false;
  let requestToken = 0;
  let autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let feedbackKey: MessageKey | null = null;
  let stopAgeTick: (() => void) | null = null;
  let nowTimestamp = Date.now();

  let contentView: ContentView = "orders";
  let side: BrowseSide = "sell";
  // Default to in-game sellers - the only ones you can actually trade with.
  let statusFilter: StatusFilter = "ingame";
  let rankFilter: RankFilter = "all";
  let minPrice: number | null = null;
  let maxPrice: number | null = null;
  let tradingTax: number | null = null;

  const savedStore = savedSearches("marketBrowse");
  const tradingTaxCache = new SvelteMap<string, number | null>();

  $: currentSaved = isSaved(selected, $savedStore);

  function isSaved(item: BrowseItem | null, saved: string[]): boolean {
    if (!item) return false;
    const key = item.name.toLowerCase();
    return saved.some((name) => name.toLowerCase() === key);
  }

  function saveCurrent(): void {
    if (selected) addSavedSearch("marketBrowse", selected.name);
  }

  function applySaved(name: string): void {
    const item = catalog.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (item) pick(item);
    else query = name;
  }

  $: catalog = buildCatalog($wfmItems);

  function buildCatalog(lookup: WfmItemsLookup): BrowseItem[] {
    // The lookup is keyed by name and includes aliases, so several keys can
    // share one slug - dedupe or the suggestion list gets duplicate keys.
    const bySlug = new SvelteMap<string, BrowseItem>();
    const named = new SvelteSet<string>();
    for (const entry of Object.values(lookup)) {
      if (!entry.url_name || named.has(entry.url_name)) continue;
      bySlug.set(entry.url_name, {
        name: entry.item_name || titleFromSlug(entry.url_name),
        slug: entry.url_name,
        thumb: formatWfmAssetUrl(entry.thumb || entry.icon),
        gameRef: entry.gameRef ?? null,
        maxRank: entry.maxRank ?? null,
      });
      if (entry.item_name) named.add(entry.url_name);
    }
    return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  $: suggestions = buildSuggestions(catalog, query);
  $: suggestionsOpen = showSuggestions && suggestions.length > 0;
  // A new query builds a new list, so the highlight must not stay on the index
  // it held for the old one.
  $: if (suggestions) activeSuggestion = 0;

  function buildSuggestions(items: BrowseItem[], rawQuery: string): BrowseItem[] {
    const needle = rawQuery.trim().toLowerCase();
    if (needle.length < 2) return [];
    const starts: BrowseItem[] = [];
    const contains: BrowseItem[] = [];
    for (const item of items) {
      const hay = item.name.toLowerCase();
      if (hay.startsWith(needle)) starts.push(item);
      else if (hay.includes(needle)) contains.push(item);
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
  }

  function moveSuggestion(delta: number): void {
    if (suggestions.length === 0) return;
    showSuggestions = true;
    const next = (activeSuggestion + delta + suggestions.length) % suggestions.length;
    activeSuggestion = next;
    suggestionEls[next]?.scrollIntoView({ block: "nearest" });
  }

  function onSearchKeydown(event: KeyboardEvent): void {
    // While an IME composes, these keys belong to the candidate window.
    if (event.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSuggestion(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1);
      return;
    }
    // warframe.market opens the highlighted row on Tab, so steal the key only while
    // the list offers something; Shift+Tab stays normal focus traversal.
    const opensSuggestion = event.key === "Enter" || (event.key === "Tab" && !event.shiftKey);
    if (opensSuggestion && showSuggestions && suggestions.length > 0) {
      const target = suggestions[activeSuggestion] ?? suggestions[0];
      if (target) {
        event.preventDefault();
        pick(target);
      }
      return;
    }
    if (event.key === "Escape") showSuggestions = false;
  }

  function onSearchBlur(): void {
    // mousedown on a suggestion fires before this, so picks still land
    setTimeout(() => (showSuggestions = false), 120);
  }

  function clearSearch(): void {
    query = "";
    showSuggestions = false;
    searchEl?.focus();
  }

  function setSide(next: BrowseSide): void {
    side = next;
    rowLimit = MAX_ROWS;
  }

  function pick(item: BrowseItem): void {
    selected = item;
    query = item.name;
    showSuggestions = false;
    rankFilter = "all";
    rowLimit = MAX_ROWS;
    contentView = "orders";
    void load(item.slug);
    void loadTradingTax(item.slug);
  }

  async function loadTradingTax(slug: string): Promise<void> {
    if (tradingTaxCache.has(slug)) {
      tradingTax = tradingTaxCache.get(slug) ?? null;
      return;
    }
    tradingTax = null;
    const tax = await fetchTradingTax(slug);
    tradingTaxCache.set(slug, tax);
    if (selected?.slug === slug) tradingTax = tax;
  }

  async function fetchTradingTax(slug: string): Promise<number | null> {
    try {
      const response = await fetch(`https://api.warframe.market/v2/item/${slug}`, {
        headers: WFM_HEADERS,
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: Record<string, unknown> };
        const tax = Number(body.data?.tradingTax ?? body.data?.trading_tax);
        if (Number.isFinite(tax) && tax >= 0) return tax;
      }
    } catch {
      // fall through to the v1 shape
    }
    try {
      const response = await fetch(`https://api.warframe.market/v1/items/${slug}`, {
        headers: WFM_HEADERS,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        payload?: { item?: { items_in_set?: Array<Record<string, unknown>> } };
      };
      const set = body.payload?.item?.items_in_set ?? [];
      const row = set.find((entry) => entry.url_name === slug) ?? set[0];
      const tax = Number(row?.trading_tax);
      return Number.isFinite(tax) && tax >= 0 ? tax : null;
    } catch {
      return null;
    }
  }

  // The endpoint caps each side at 500 listings, so max-rank filtering must happen
  // upstream before rank-zero listings can crowd out maxed ones.
  function currentFetchRank(): number | null {
    return rankFilter === "maxed" && effectiveMaxRank > 0 ? effectiveMaxRank : null;
  }

  function setRankFilter(next: RankFilter): void {
    if (rankFilter === next) return;
    rankFilter = next;
    if (selected) void load(selected.slug);
  }

  async function load(slug: string): Promise<void> {
    const token = ++requestToken;
    const rank = currentFetchRank();
    orderBook = null;
    errorKey = null;
    noData = false;
    loading = true;

    let result = await fetchItemOrderBookBySlug(slug, { rank });
    if (result.status === "error") {
      clearOrderBookCache(slug, rank);
      result = await fetchItemOrderBookBySlug(slug, { rank });
    }
    if (token !== requestToken) return;

    loading = false;
    resetAutoRefresh(slug);
    if (result.status === "ok") {
      orderBook = result.data;
      nowTimestamp = Date.now();
      setAgeTick(true);
      return;
    }
    setAgeTick(false);
    if (result.status === "not_found") noData = true;
    else errorKey = "common.failedToLoadListingsTryAgain";
  }

  function refresh(): void {
    if (!selected) return;
    clearOrderBookCache(selected.slug, currentFetchRank());
    void load(selected.slug);
  }

  function resetAutoRefresh(slug: string): void {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => {
      if (selected?.slug !== slug) return;
      clearOrderBookCache(slug, currentFetchRank());
      void load(slug);
    }, AUTO_REFRESH_MS);
  }

  function setAgeTick(enabled: boolean): void {
    stopAgeTick?.();
    stopAgeTick = null;
    if (!enabled) return;
    stopAgeTick = useInterval(() => {
      nowTimestamp = Date.now();
    }, 1_000);
  }

  onDestroy(() => {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    if (copiedTimer) clearTimeout(copiedTimer);
    stopAgeTick?.();
  });

  $: selectedDbEntry = selected?.gameRef ? ($itemDb[selected.gameRef] ?? null) : null;

  // The catalog is English because warframe.market is. Only the label follows the
  // game language; every slug, order and chat line still goes out in English.
  function catalogLabel(entry: { name: string; gameRef?: string | null }): string {
    return itemLabel(entry.gameRef ? ($itemDb[entry.gameRef] ?? entry) : entry);
  }
  $: owned = computeOwned(selected, $parsedItems);

  interface OwnedInfo {
    total: number;
    ranks: Array<{ rank: number; count: number }>;
  }

  // Mods/arcanes come as one parsed entry per rank; other groups can repeat
  // an item across set-style views, where max avoids double-counting.
  function computeOwned(item: BrowseItem | null, parsed: ParsedItem[]): OwnedInfo {
    if (!item) return { total: 0, ranks: [] };
    const nameKey = item.name.toLowerCase();
    const matches = parsed.filter(
      (row) =>
        (item.gameRef && row.internalName === item.gameRef) || row.name.toLowerCase() === nameKey,
    );
    const rankedRows = matches.filter(
      (row) => row.inventoryGroup === "mods" || row.inventoryGroup === "arcanes",
    );
    if (rankedRows.length > 0) {
      const byRank = new SvelteMap<number, number>();
      for (const row of rankedRows) {
        byRank.set(row.rank, (byRank.get(row.rank) ?? 0) + (row.amount ?? 0));
      }
      const ranks = [...byRank.entries()]
        .map(([rank, count]) => ({ rank, count }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.rank - a.rank);
      return { total: ranks.reduce((sum, entry) => sum + entry.count, 0), ranks };
    }
    let best = 0;
    for (const row of matches) best = Math.max(best, row.amount ?? 0);
    return { total: best, ranks: [] };
  }

  function openDetails(): void {
    if (!selected?.gameRef || !selectedDbEntry) return;
    activeItem.set(buildParsedItemFromDb(selected.gameRef, selectedDbEntry, $componentOwnership));
  }

  $: allEntries = [...(orderBook?.sell ?? []), ...(orderBook?.buy ?? [])];
  $: ranked = (selected?.maxRank ?? 0) > 0 || allEntries.some((entry) => entry.rank != null);
  $: effectiveMaxRank =
    selected?.maxRank ?? allEntries.reduce((max, entry) => Math.max(max, entry.rank ?? 0), 0) ?? 0;

  $: sideEntries = side === "sell" ? (orderBook?.sell ?? []) : (orderBook?.buy ?? []);
  $: filteredRows = filterRows(sideEntries, statusFilter, rankFilter, minPrice, maxPrice);
  $: rows = filteredRows.slice(0, rowLimit);

  function filterRows(
    entries: OrderBookEntry[],
    status: StatusFilter,
    rank: RankFilter,
    min: number | null,
    max: number | null,
  ): OrderBookEntry[] {
    let out = entries;
    if (status === "ingame") out = out.filter((entry) => entry.status === "ingame");
    else if (status === "onsite") out = out.filter((entry) => entry.status === "online");
    if (rank === "maxed" && effectiveMaxRank > 0) {
      out = out.filter((entry) => (entry.rank ?? 0) >= effectiveMaxRank);
    }
    if (min != null && min > 0) out = out.filter((entry) => entry.platinum >= min);
    if (max != null && max > 0) out = out.filter((entry) => entry.platinum <= max);
    return out;
  }

  function statusLabelKey(status: string | null): MessageKey {
    if (status === "ingame") return "browse.status.ingame";
    if (status === "online") return "common.online";
    if (status === "invisible") return "common.invisible";
    return "common.offline";
  }

  function formatUpdatedLabel(
    translate: Translator,
    timestamp: number | null | undefined,
    nowMs: number,
  ): string {
    if (!timestamp || timestamp <= 0) return translate("common.updatedRecently");
    const ageSec = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
    if (ageSec < 5) return translate("common.updatedJustNow");
    if (ageSec < 60) return translate("common.updatedSAgo", { sec: ageSec });
    const ageMin = Math.floor(ageSec / 60);
    if (ageMin < 60) return translate("common.updatedMAgo", { min: ageMin });
    return translate("common.updatedHAgo", { hr: Math.floor(ageMin / 60) });
  }

  function setFeedback(key: MessageKey): void {
    feedbackKey = key;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedbackKey = null;
      feedbackTimer = null;
    }, FEEDBACK_TTL_MS);
  }

  function buildWhisper(entry: OrderBookEntry): string {
    if (!selected) return "";
    const quantitySuffix = entry.quantity > 1 ? ` x${entry.quantity}` : "";
    const rankSuffix = ranked && entry.rank != null ? ` (Rank ${entry.rank})` : "";
    const itemText = `${selected.name}${rankSuffix}${quantitySuffix}`;
    if (side === "sell") {
      return $translate("common.whisperBuy", {
        user: entry.userName,
        item: itemText,
        platinum: entry.platinum,
      });
    }
    return $translate("common.whisperSell", {
      user: entry.userName,
      item: itemText,
      platinum: entry.platinum,
    });
  }

  let copiedKey: string | null = null;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  function markCopied(key: string): void {
    copiedKey = key;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedKey = null;
      copiedTimer = null;
    }, 1_600);
  }

  async function copyWhisper(entry: OrderBookEntry, key: string): Promise<void> {
    const message = buildWhisper(entry);
    if (!message) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
        markCopied(key);
        setFeedback("browse.whisperCopied");
        return;
      }
      setFeedback("common.clipboardUnavailableInThisEnvironment");
    } catch {
      setFeedback("common.failedToCopyWhisper");
    }
  }

  function openProfile(entry: OrderBookEntry): void {
    send("open-external", `https://warframe.market/profile/${encodeURIComponent(entry.userName)}`);
  }

  // WFM avatars aren't mirrored; when Cloudflare blocks the upstream load,
  // hiding the img reveals the initial-letter circle behind it.
  function hideBrokenAvatar(event: Event): void {
    const img = event.currentTarget as HTMLImageElement | null;
    if (img) img.style.display = "none";
  }

  function openOnWarframeMarket(): void {
    if (!selected) return;
    send("open-external", `https://warframe.market/items/${selected.slug}`);
  }

  function isLookupItem(value: unknown): value is WfmLookupItem {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      row.id.trim().length > 0 &&
      typeof row.item_name === "string" &&
      typeof row.url_name === "string"
    );
  }

  async function openPostOrder(orderType: BrowseSide): Promise<void> {
    if (!selected) return;

    const session = await invoke("wfmGetSession");
    if (!session.loggedIn) {
      setFeedback("browse.signInRequired");
      return;
    }

    const lookup = await invoke("wfmLookupItemBySlug", selected.slug);
    if (isIpcError(lookup) || !isLookupItem(lookup)) {
      setFeedback("browse.orderPrepFailed");
      return;
    }

    orderModalState.set({
      mode: "create",
      order: null,
      draft: {
        item: lookup,
        orderType,
        modRank: rankFilter === "maxed" && effectiveMaxRank > 0 ? effectiveMaxRank : null,
        maxRank: effectiveMaxRank > 0 ? effectiveMaxRank : null,
      },
    });
  }
</script>

<div class="grid gap-3" data-tour="market-browse">
  <div class="mx-auto flex w-[min(640px,100%)] items-center gap-2">
    <div class="relative min-w-0 flex-1">
      <div
        class="flex items-stretch overflow-hidden rounded-lg border border-border bg-bg-surface focus-within:border-accent focus-within:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_28%,transparent)]"
      >
        <input
          class="min-w-0 flex-1 border-0 bg-transparent px-3.5 py-2.5 text-base text-text-primary outline-none placeholder:text-text-muted"
          type="text"
          placeholder={$translate("browse.searchPlaceholder")}
          bind:value={query}
          bind:this={searchEl}
          on:input={() => (showSuggestions = true)}
          on:focus={() => (showSuggestions = true)}
          on:keydown={onSearchKeydown}
          on:blur={onSearchBlur}
          role="combobox"
          aria-expanded={suggestionsOpen}
          aria-controls={SUGGESTION_LIST_ID}
          aria-activedescendant={suggestionsOpen
            ? `${SUGGESTION_LIST_ID}-${activeSuggestion}`
            : undefined}
          data-search-focus
        />
        {#if query}
          <button
            type="button"
            class="flex cursor-pointer items-center border-0 bg-transparent px-2 text-base leading-none text-text-muted hover:text-text-primary"
            aria-label={$translate("common.clearSearch")}
            on:mousedown|preventDefault={clearSearch}>&times;</button
          >
        {/if}
        <div class="flex items-center border-l border-border bg-accent-glow px-3 text-accent">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="h-4 w-4"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </div>
      </div>
      {#if suggestionsOpen}
        <div
          class="absolute inset-x-0 top-full z-30 mt-1 max-h-[22rem] overflow-y-auto rounded-lg border border-border bg-bg-raised"
          role="listbox"
          id={SUGGESTION_LIST_ID}
        >
          {#each suggestions as suggestion, suggestionIndex (suggestion.slug)}
            <button
              type="button"
              class="flex w-full items-center gap-2.5 border-0 bg-transparent px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
              class:is-active={suggestionIndex === activeSuggestion}
              bind:this={suggestionEls[suggestionIndex]}
              role="option"
              id={`${SUGGESTION_LIST_ID}-${suggestionIndex}`}
              aria-selected={suggestionIndex === activeSuggestion}
              on:mouseenter={() => (activeSuggestion = suggestionIndex)}
              on:mousedown|preventDefault={() => pick(suggestion)}
            >
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-card"
              >
                <ItemImage
                  src={suggestion.thumb}
                  fallbackSrc={suggestion.gameRef
                    ? ($itemDb[suggestion.gameRef]?.imageUrl ?? null)
                    : null}
                  alt={catalogLabel(suggestion)}
                  cls="max-h-full max-w-full"
                />
              </span>
              <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                >{catalogLabel(suggestion)}</span
              >
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button
      type="button"
      class="shrink-0 rounded-lg border px-3 py-2 text-base disabled:cursor-default disabled:opacity-40 {currentSaved
        ? 'border-accent/50 bg-accent-glow text-accent'
        : 'border-border bg-bg-soft text-text-secondary hover:text-text-primary'}"
      disabled={!selected}
      title={currentSaved ? $translate("browse.alreadySaved") : $translate("browse.saveItem")}
      on:click={saveCurrent}>★</button
    >
  </div>

  {#if $savedStore.length > 0}
    <div class="mx-auto flex w-[min(640px,100%)] flex-wrap items-center gap-1.5">
      <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
        >{$translate("common.saved")}</span
      >
      {#each $savedStore as saved (saved)}
        <span
          class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm {selected &&
          selected.name.toLowerCase() === saved.toLowerCase()
            ? 'border-accent/50 bg-accent-glow text-accent'
            : 'border-border bg-bg-soft text-text-secondary'}"
        >
          <button
            type="button"
            class="cursor-pointer border-0 bg-transparent p-0 text-inherit hover:text-text-primary"
            title={$translate("browse.openItem")}
            on:click={() => applySaved(saved)}>{saved}</button
          >
          <button
            type="button"
            class="cursor-pointer border-0 bg-transparent p-0 text-inherit opacity-60 hover:opacity-100"
            title={$translate("browse.removeSavedItem")}
            on:click={() => removeSavedSearch("marketBrowse", saved)}>×</button
          >
        </span>
      {/each}
    </div>
  {/if}

  {#if feedbackKey}
    <div
      class="mx-auto w-[min(640px,100%)] rounded-lg border border-accent-dim bg-accent-glow px-3 py-2 text-center text-xs font-semibold text-accent-bright"
    >
      {$translate(feedbackKey)}
    </div>
  {/if}

  {#if !selected}
    <div
      class="mx-auto w-[min(640px,100%)] rounded-xl border border-dashed border-border bg-bg-soft px-4 py-8 text-center text-sm text-text-secondary"
    >
      {$translate("browse.emptyHint")}
    </div>
  {:else}
    <div
      class="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-bg-surface p-4"
    >
      <div
        class="flex h-[84px] w-[84px] shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-accent bg-surface-card"
      >
        <ItemImage
          src={selected.thumb}
          fallbackSrc={selected.gameRef ? ($itemDb[selected.gameRef]?.imageUrl ?? null) : null}
          alt={catalogLabel(selected)}
          cls="max-h-[72px] max-w-[72px]"
        />
      </div>
      <div class="min-w-0 flex-1">
        <h3
          class="m-0 font-display text-2xl font-bold uppercase tracking-[0.04em] text-text-primary"
        >
          {catalogLabel(selected)}
        </h3>
        <div class="mt-1 flex flex-wrap items-center gap-3 text-xs text-text-secondary">
          <span class={owned.total > 0 ? "font-semibold text-success" : ""}
            >{$translate("browse.owned", { count: owned.total })}{owned.ranks.length > 0
              ? ` (${owned.ranks.map((entry) => `${entry.count}x R${entry.rank}`).join(", ")})`
              : ""}</span
          >
          {#if tradingTax != null}
            <span class="inline-flex items-center gap-1"
              >{$translate("browse.tradingTax")}
              {tradingTax.toLocaleString($locale)}<img
                src={CREDITS_ICON_URL}
                alt={$translate("common.credits")}
                class="h-3.5 w-3.5 object-contain"
              /></span
            >
          {/if}
          {#if ranked}<span>{$translate("browse.maxRank", { rank: effectiveMaxRank })}</span>{/if}
          <button type="button" class="link-btn" on:click={openOnWarframeMarket}
            >{$translate("common.openOnWarframeMarket")}</button
          >
          {#if orderBook && !loading}
            <span class="text-text-muted"
              >{formatUpdatedLabel($translate, orderBook.timestamp ?? null, nowTimestamp)}</span
            >
          {/if}
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        {#if selectedDbEntry}
          <button class="btn-secondary btn-sm" on:click={openDetails}
            >{$translate("common.details")}</button
          >
        {/if}
        <WikiButton wikiUrl={selectedDbEntry?.wikiaUrl ?? null} fallbackName={selected.name} />
        <button class="btn-success btn-sm" on:click={() => void openPostOrder("sell")}
          >{$translate("common.postWts")}</button
        >
        <button class="btn-danger btn-sm" on:click={() => void openPostOrder("buy")}
          >{$translate("common.postWtb")}</button
        >
        <button class="btn-secondary btn-sm" on:click={refresh}
          >{$translate("common.refresh")}</button
        >
      </div>
    </div>

    <div class="filter-tabs">
      <button
        class="filter-tab"
        class:active={contentView === "orders"}
        on:click={() => (contentView = "orders")}>{$translate("browse.tabOrders")}</button
      >
      <button
        class="filter-tab"
        class:active={contentView === "stats"}
        on:click={() => (contentView = "stats")}>{$translate("browse.tabStatistics")}</button
      >
    </div>

    {#if contentView === "stats"}
      <MarketBrowseStats slug={selected.slug} />
    {:else}
      <div class="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div class="grid gap-1">
          <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
            >{$translate("common.orderType")}</span
          >
          <div class="filter-tabs">
            <button
              class="filter-tab browse-side-sell"
              class:active={side === "sell"}
              on:click={() => setSide("sell")}>{$translate("browse.sellers")}</button
            >
            <button
              class="filter-tab browse-side-buy"
              class:active={side === "buy"}
              on:click={() => setSide("buy")}>{$translate("browse.buyers")}</button
            >
          </div>
        </div>
        <div class="grid gap-1">
          <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
            >{$translate("browse.status")}</span
          >
          <div class="filter-tabs">
            <button
              class="filter-tab"
              class:active={statusFilter === "ingame"}
              on:click={() => (statusFilter = "ingame")}>{$translate("common.inGame")}</button
            >
            <button
              class="filter-tab"
              class:active={statusFilter === "onsite"}
              on:click={() => (statusFilter = "onsite")}>{$translate("browse.onSite")}</button
            >
            <button
              class="filter-tab"
              class:active={statusFilter === "all"}
              on:click={() => (statusFilter = "all")}>{$translate("common.all")}</button
            >
          </div>
        </div>
        {#if ranked}
          <div class="grid gap-1">
            <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
              >{$translate("common.rank")}</span
            >
            <div class="filter-tabs">
              <button
                class="filter-tab"
                class:active={rankFilter === "all"}
                on:click={() => setRankFilter("all")}>{$translate("common.all")}</button
              >
              <button
                class="filter-tab"
                class:active={rankFilter === "maxed"}
                on:click={() => setRankFilter("maxed")}>{$translate("browse.maxed")}</button
              >
            </div>
          </div>
        {/if}
        <div class="grid gap-1">
          <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
            >{$translate("common.price")}</span
          >
          <div class="flex items-center gap-1.5">
            <input
              class="browse-price-input"
              type="number"
              min="0"
              placeholder={$translate("common.min")}
              bind:value={minPrice}
            />
            <span class="text-xs text-text-muted">-</span>
            <input
              class="browse-price-input"
              type="number"
              min="0"
              placeholder={$translate("common.max")}
              bind:value={maxPrice}
            />
          </div>
        </div>
      </div>

      {#if loading}
        <div
          class="rounded-xl border border-dashed border-border bg-bg-soft px-4 py-6 text-center text-sm text-text-secondary"
        >
          {$translate("common.loadingListings")}
        </div>
      {:else if errorKey}
        <div
          class="rounded-xl border border-dashed border-danger/40 bg-bg-soft px-4 py-6 text-center text-sm text-danger"
        >
          {$translate(errorKey)}
        </div>
      {:else if noData || !orderBook}
        <div
          class="rounded-xl border border-dashed border-border bg-bg-soft px-4 py-6 text-center text-sm text-text-secondary"
        >
          {$translate("browse.noListings")}
        </div>
      {:else if rows.length === 0}
        <div
          class="rounded-xl border border-dashed border-border bg-bg-soft px-4 py-6 text-center text-sm text-text-secondary"
        >
          {side === "sell" ? $translate("browse.noOrdersSell") : $translate("browse.noOrdersBuy")}
        </div>
      {:else}
        <div class="overflow-hidden rounded-xl border border-border">
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr
                class="bg-bg-raised text-left text-xs uppercase tracking-[0.05em] text-text-muted [&>th]:px-3 [&>th]:py-2 [&>th]:font-semibold"
              >
                <th>{$translate("browse.col.qty")}</th>
                <th>{$translate("browse.col.user")}</th>
                <th>{$translate("browse.status")}</th>
                {#if ranked}<th class="text-right">{$translate("common.rank")}</th>{/if}
                <th class="text-right">{$translate("browse.col.unitPrice")}</th>
                <th class="text-right"
                  >{side === "sell"
                    ? $translate("browse.col.buy")
                    : $translate("browse.col.sell")}</th
                >
              </tr>
            </thead>
            <tbody>
              {#each rows as entry, index (`${entry.userName}:${entry.platinum}:${index}`)}
                {@const rowKey = `${entry.userName}:${entry.platinum}:${index}`}
                <tr
                  class="border-t border-border/60 bg-bg-surface transition-colors duration-100 hover:bg-surface-hover [&>td]:px-3 [&>td]:py-2"
                >
                  <td class="text-text-secondary">x{entry.quantity}</td>
                  <td>
                    <div class="flex items-center gap-2">
                      <span
                        class="relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-bg-raised text-[10px] font-bold text-text-muted"
                      >
                        {entry.userName.slice(0, 1).toUpperCase()}
                        {#if entry.avatar}
                          <img
                            class="absolute inset-0 h-full w-full object-cover"
                            src={formatWfmAssetUrl(entry.avatar)}
                            alt=""
                            loading="lazy"
                            on:error={hideBrokenAvatar}
                          />
                        {/if}
                      </span>
                      <button
                        type="button"
                        class="link-btn font-semibold"
                        title={$translate("browse.openProfile")}
                        on:click={() => openProfile(entry)}>{entry.userName}</button
                      >
                    </div>
                  </td>
                  <td>
                    <span
                      class="text-xs font-semibold uppercase tracking-[0.04em] {entry.status ===
                      'ingame'
                        ? 'text-success'
                        : entry.status === 'online'
                          ? 'text-info'
                          : 'text-text-muted'}">{$translate(statusLabelKey(entry.status))}</span
                    >
                  </td>
                  {#if ranked}
                    <td class="text-right text-text-secondary"
                      >{entry.rank != null ? `R${entry.rank}` : "-"}</td
                    >
                  {/if}
                  <td class="text-right font-display text-base font-bold text-accent"
                    >{entry.platinum}p</td
                  >
                  <td class="text-right">
                    <button
                      class="{copiedKey === rowKey
                        ? 'btn-success'
                        : 'btn-secondary'} btn-sm min-w-[104px]"
                      title={buildWhisper(entry)}
                      on:click={() => void copyWhisper(entry, rowKey)}
                      >{copiedKey === rowKey
                        ? $translate("common.copied")
                        : $translate("browse.copyWhisper")}</button
                    >
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="text-center text-xs text-text-muted">
          {side === "sell"
            ? $translate("browse.showingSell", { shown: rows.length, total: filteredRows.length })
            : $translate("browse.showingBuy", { shown: rows.length, total: filteredRows.length })}
          {#if filteredRows.length > rows.length}
            <button class="link-btn" on:click={() => (rowLimit += MAX_ROWS)}
              >{$translate("browse.showMore", {
                n: Math.min(MAX_ROWS, filteredRows.length - rows.length),
              })}</button
            >
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  /* Sell/buy sides mirror the Post WTS (green) / Post WTB (red) buttons. */
  .browse-side-sell {
    color: color-mix(in oklab, var(--success) 65%, var(--text-secondary));
  }
  .browse-side-sell:hover {
    color: var(--success);
  }
  .browse-side-sell.active {
    border-color: color-mix(in oklab, var(--success) 55%, transparent);
    background: color-mix(in oklab, var(--success) 12%, transparent);
    color: var(--success);
  }
  .browse-side-buy {
    color: color-mix(in oklab, var(--danger) 65%, var(--text-secondary));
  }
  .browse-side-buy:hover {
    color: var(--danger);
  }
  .browse-side-buy.active {
    border-color: color-mix(in oklab, var(--danger) 55%, transparent);
    background: color-mix(in oklab, var(--danger) 12%, transparent);
    color: var(--danger);
  }
  .browse-price-input {
    width: 4.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    color: var(--text-primary);
    padding: 0.3rem 0.4rem;
    font-size: 0.78rem;
  }
  .browse-price-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 30%, transparent);
  }
  .is-active {
    background: color-mix(in oklab, var(--accent) 16%, transparent);
  }
</style>
