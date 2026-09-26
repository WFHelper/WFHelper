<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import ItemImage from "../ItemImage.svelte";
  import SortHeaderButton from "../SortHeaderButton.svelte";
  import { nextColumnSort } from "../../lib/filters.js";
  import { itemLabel } from "../../lib/itemLabel.js";
  import { locale, tr as translate, type MessageKey, type Translator } from "../../lib/i18n.js";
  import { send } from "../../lib/ipc.js";
  import { itemDb } from "../../stores/data.js";
  import {
    clearOrderBookCache,
    fetchItemOrderBookBySlug,
    type OrderBookEntry,
  } from "../../lib/wfm/orderBook.js";
  import { loadQueueMarketData } from "../../lib/tradeWorkbench/queueModel.js";
  import {
    ayatanOrderWhisper,
    ayatanSortStart,
    buildAyatanListings,
    EMPTY_AYATAN_BOOK,
    formatLoadAge,
    loadAyatanViewPrefs,
    saveAyatanViewPrefs,
    settleAyatanBook,
    sortAyatanListings,
    summarizeAyatanBooks,
    type AyatanBookState,
    type AyatanListing,
    type AyatanSortKey,
    type AyatanStarsFilter,
    type AyatanViewPrefs,
  } from "../../lib/wfm/ayatanListings.js";
  import { sellerStatusLabelKey, type SellerStatusFilter } from "../../lib/wfm/orderRows.js";
  import { useInterval } from "../../lib/timers.js";
  import { AYATAN_SCULPTURES, ayatanSculptureBySlug } from "../../../config/shared/ayatanEndo.js";
  import { formatUnitPlatinum } from "../../../config/shared/wfmOrders.js";
  import { titleFromSlug } from "../../../config/shared/wfm.js";

  interface CatalogRef {
    name: string;
    slug: string;
    thumb: string | null;
    gameRef: string | null;
  }

  interface Props {
    catalog: readonly CatalogRef[];
    onOpenItem: (slug: string) => void;
    onFeedback: (key: MessageKey) => void;
  }

  let { catalog, onOpenItem, onFeedback }: Props = $props();

  const AUTO_REFRESH_MS = 45_000;
  const MAX_ROWS = 50;

  const COLUMNS: ReadonlyArray<{ key: AyatanSortKey; labelKey: MessageKey; alignEnd: boolean }> = [
    { key: "sculpture", labelKey: "browse.ayatan.col.sculpture", alignEnd: false },
    { key: "qty", labelKey: "browse.col.qty", alignEnd: false },
    { key: "user", labelKey: "browse.col.user", alignEnd: false },
    { key: "status", labelKey: "browse.status", alignEnd: false },
    { key: "unitPrice", labelKey: "browse.col.unitPrice", alignEnd: true },
    { key: "endoPerPlat", labelKey: "browse.col.endoPerPlat", alignEnd: true },
  ];
  const STATUS_OPTIONS: ReadonlyArray<{ value: SellerStatusFilter; labelKey: MessageKey }> = [
    { value: "ingame", labelKey: "common.inGame" },
    { value: "onsite", labelKey: "browse.onSite" },
    { value: "all", labelKey: "common.all" },
  ];
  const STARS_OPTIONS: ReadonlyArray<{ value: AyatanStarsFilter; labelKey: MessageKey }> = [
    { value: "any", labelKey: "filters.any" },
    { value: "full", labelKey: "browse.ayatan.starsFull" },
    { value: "none", labelKey: "common.none" },
  ];

  let books = $state.raw<Record<string, AyatanBookState>>({});
  let prefs = $state<AyatanViewPrefs>(loadAyatanViewPrefs());
  let rowLimit = $state(MAX_ROWS);
  let copiedKey = $state<string | null>(null);
  let sculptureMenuOpen = $state(false);
  let sculptureFilterRoot = $state<HTMLDivElement>();
  let sculptureTrigger = $state<HTMLButtonElement>();
  let now = $state(Date.now());

  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let stopClock: (() => void) | null = null;

  const catalogBySlug = $derived(new Map(catalog.map((entry) => [entry.slug, entry])));
  const loadedBooks = $derived(
    AYATAN_SCULPTURES.flatMap((sculpture) => {
      const sell = books[sculpture.slug]?.sell ?? [];
      return sell.length > 0 ? [{ sculpture, sell }] : [];
    }),
  );
  const listings = $derived(
    sortAyatanListings(buildAyatanListings(loadedBooks, prefs), prefs, (slug) =>
      refLabel(slug, $itemDb),
    ),
  );
  const sculptureOptions = $derived(
    AYATAN_SCULPTURES.map(({ slug }) => ({ slug, label: refLabel(slug, $itemDb) })).sort((a, b) =>
      a.label.localeCompare(b.label),
    ),
  );
  const rows = $derived(listings.slice(0, rowLimit));
  const load = $derived(
    summarizeAyatanBooks(AYATAN_SCULPTURES.map(({ slug }) => books[slug] ?? EMPTY_AYATAN_BOOK)),
  );
  const bestEndoPerPlat = $derived(
    listings.reduce<number | null>((best, row) => Math.max(best ?? 0, row.endoPerPlat), null),
  );

  $effect(() => {
    saveAyatanViewPrefs($state.snapshot(prefs));
  });

  function setBook(slug: string, next: AyatanBookState): void {
    books = { ...books, [slug]: next };
  }

  async function loadAll(force: boolean): Promise<void> {
    const token = ++generation;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    books = Object.fromEntries(
      AYATAN_SCULPTURES.map(({ slug }) => [
        slug,
        { ...(books[slug] ?? EMPTY_AYATAN_BOOK), loading: true },
      ]),
    );
    // A failed book waits for the next refresh: an instant retry after a 429 only adds load.
    const results: Record<string, Awaited<ReturnType<typeof fetchItemOrderBookBySlug>>> = {};
    await loadQueueMarketData(
      AYATAN_SCULPTURES.map(({ slug }) => ({ rowId: slug })),
      {
        isCancelled: () => token !== generation,
        fetchBook: async ({ rowId }) => {
          if (force) clearOrderBookCache(rowId);
          const result = await fetchItemOrderBookBySlug(rowId);
          results[rowId] = result;
          return result.status === "ok" ? { sell: result.data.sell, buy: result.data.buy } : null;
        },
        onRow: ({ rowId }) => {
          if (token !== generation) return;
          setBook(rowId, settleAyatanBook(books[rowId] ?? EMPTY_AYATAN_BOOK, results[rowId]));
        },
      },
    );
    if (token !== generation) return;
    refreshTimer = setTimeout(() => void loadAll(true), AUTO_REFRESH_MS);
  }

  onMount(() => {
    void loadAll(false);
    stopClock = useInterval(() => {
      now = Date.now();
    }, 1_000);
  });

  onDestroy(() => {
    generation += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (copiedTimer) clearTimeout(copiedTimer);
    stopClock?.();
  });

  function refLabel(slug: string, db: typeof $itemDb): string {
    const ref = catalogBySlug.get(slug);
    const dbEntry = ref?.gameRef ? db[ref.gameRef] : undefined;
    return itemLabel(dbEntry ?? { name: ref?.name ?? titleFromSlug(slug) });
  }

  function rowKey(row: AyatanListing, index: number): string {
    return `${row.slug}:${row.entry.userName}:${row.entry.platinum}:${index}`;
  }

  function whisperFor(row: AyatanListing, t: Translator): string {
    const name = catalogBySlug.get(row.slug)?.name ?? titleFromSlug(row.slug);
    return ayatanOrderWhisper(t, "sell", row.entry, name, ayatanSculptureBySlug(row.slug));
  }

  async function copyWhisper(row: AyatanListing, key: string): Promise<void> {
    const message = whisperFor(row, $translate);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message);
        copiedKey = key;
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => {
          copiedKey = null;
          copiedTimer = null;
        }, 1_600);
        onFeedback("browse.whisperCopied");
        return;
      }
      onFeedback("common.clipboardUnavailableInThisEnvironment");
    } catch {
      onFeedback("common.failedToCopyWhisper");
    }
  }

  function openProfile(entry: OrderBookEntry): void {
    send("open-external", `https://warframe.market/profile/${encodeURIComponent(entry.userName)}`);
  }

  function sortByColumn(sortKey: AyatanSortKey): void {
    const next = nextColumnSort(prefs, sortKey, ayatanSortStart);
    prefs.sortBy = next.sortBy;
    prefs.sortDirection = next.sortDirection;
    rowLimit = MAX_ROWS;
  }

  function setStatus(next: SellerStatusFilter): void {
    prefs.status = next;
    rowLimit = MAX_ROWS;
  }

  function setStars(next: AyatanStarsFilter): void {
    prefs.stars = next;
    rowLimit = MAX_ROWS;
  }

  function toggleSculpture(slug: string): void {
    const current = prefs.sculptures;
    prefs.sculptures = current.includes(slug)
      ? current.filter((entry) => entry !== slug)
      : [...current, slug];
    rowLimit = MAX_ROWS;
  }

  function showEverySculpture(event: Event & { currentTarget: HTMLInputElement }): void {
    // Unticking "All" has nothing to fall back to, so the box stays ticked.
    event.currentTarget.checked = true;
    prefs.sculptures = [];
    rowLimit = MAX_ROWS;
  }

  function closeSculptureMenuOutside(event: Event): void {
    if (!sculptureMenuOpen || !(event.target instanceof Node)) return;
    if (!sculptureFilterRoot?.contains(event.target)) sculptureMenuOpen = false;
  }

  // The menu itself takes focus (tabindex -1) when a label is clicked, so only
  // tabbing past the last box closes it here.
  function closeSculptureMenuOnFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && sculptureFilterRoot?.contains(next)) return;
    sculptureMenuOpen = false;
  }

  function closeSculptureMenuOnEscape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !sculptureMenuOpen) return;
    sculptureMenuOpen = false;
    sculptureTrigger?.focus();
  }
</script>

<svelte:window onpointerdown={closeSculptureMenuOutside} onkeydown={closeSculptureMenuOnEscape} />

<div class="grid gap-3" data-ayatan-endo-browse>
  <div
    class="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border bg-bg-surface px-4 py-3"
    data-ayatan-header
  >
    <div class="min-w-[16rem] flex-1">
      <h3 class="m-0 font-display text-lg font-bold text-text-primary">
        {$translate("browse.ayatan.preset")}
      </h3>
      <p class="m-0 mt-0.5 max-w-[34rem] text-xs text-text-secondary">
        {$translate("browse.ayatan.explainer")}
      </p>
    </div>
    <dl class="m-0 flex flex-wrap items-center gap-x-5 gap-y-2" data-ayatan-summary>
      <div class="grid gap-0.5">
        <dt class="text-xs uppercase tracking-[0.05em] text-text-muted">
          {$translate("browse.ayatan.bestEndoPerPlat")}
        </dt>
        <dd
          class="m-0 font-display text-base font-bold text-accent"
          data-ayatan-best={bestEndoPerPlat ?? ""}
        >
          {bestEndoPerPlat != null ? bestEndoPerPlat.toLocaleString($locale) : "-"}
        </dd>
      </div>
      <div class="grid gap-0.5 border-l border-border pl-5">
        <dt class="text-xs uppercase tracking-[0.05em] text-text-muted">
          {$translate("browse.ayatan.orderCount")}
        </dt>
        <dd
          class="m-0 font-display text-base font-bold text-text-primary"
          data-ayatan-order-count={listings.length}
        >
          {listings.length.toLocaleString($locale)}
        </dd>
      </div>
      <div class="grid gap-0.5 border-l border-border pl-5">
        <dt class="text-xs uppercase tracking-[0.05em] text-text-muted">
          {$translate("browse.ayatan.updated")}
        </dt>
        <dd
          class="m-0 font-display text-base font-bold {load.notice?.since != null
            ? 'text-warning'
            : 'text-text-primary'}"
          data-ayatan-updated={load.updatedAt ?? ""}
        >
          {load.updatedAt != null ? formatLoadAge(load.updatedAt, now, $locale) : "-"}
        </dd>
      </div>
    </dl>
    <button class="btn-secondary btn-sm" data-ayatan-refresh onclick={() => void loadAll(true)}
      >{$translate("common.refresh")}</button
    >
  </div>

  <div class="flex flex-wrap items-end gap-x-4 gap-y-2" data-ayatan-filters>
    <div class="grid gap-1">
      <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
        >{$translate("browse.status")}</span
      >
      <div class="filter-tabs">
        {#each STATUS_OPTIONS as option (option.value)}
          <button
            type="button"
            class="filter-tab"
            class:active={prefs.status === option.value}
            aria-pressed={prefs.status === option.value}
            data-ayatan-status={option.value}
            onclick={() => setStatus(option.value)}>{$translate(option.labelKey)}</button
          >
        {/each}
      </div>
    </div>
    <div
      class="relative grid gap-1"
      bind:this={sculptureFilterRoot}
      onfocusout={closeSculptureMenuOnFocusOut}
    >
      <span
        id="ayatan-sculpture-filter-label"
        class="text-xs uppercase tracking-[0.05em] text-text-muted"
        >{$translate("browse.ayatan.col.sculpture")}</span
      >
      <button
        type="button"
        class="shared-filter-select relative min-w-[11rem] max-w-[16rem] cursor-pointer truncate text-text-primary"
        aria-haspopup="true"
        aria-expanded={sculptureMenuOpen}
        aria-controls="ayatan-sculpture-menu"
        data-ayatan-sculpture-filter
        bind:this={sculptureTrigger}
        onclick={() => (sculptureMenuOpen = !sculptureMenuOpen)}
      >
        {prefs.sculptures.length === 0
          ? $translate("common.all")
          : prefs.sculptures.length === 1
            ? refLabel(prefs.sculptures[0] ?? "", $itemDb)
            : $translate("common.selected", { count: prefs.sculptures.length })}
        <svg
          class="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted {sculptureMenuOpen
            ? ''
            : 'rotate-180'}"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          aria-hidden="true"
        >
          <path d="M6 15l6-6 6 6" />
        </svg>
      </button>
      {#if sculptureMenuOpen}
        <div
          id="ayatan-sculpture-menu"
          role="group"
          aria-labelledby="ayatan-sculpture-filter-label"
          tabindex="-1"
          class="absolute left-0 top-full z-20 mt-1 grid max-h-[22rem] w-max min-w-full gap-0.5 overflow-y-auto rounded-[var(--radius-md)] border border-border-strong bg-bg-surface p-1.5 outline-none"
          data-ayatan-sculpture-menu
        >
          <label
            class="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          >
            <input
              type="checkbox"
              checked={prefs.sculptures.length === 0}
              data-ayatan-sculpture-option="all"
              onchange={showEverySculpture}
            />
            {$translate("common.all")}
          </label>
          {#each sculptureOptions as option (option.slug)}
            <label
              class="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            >
              <input
                type="checkbox"
                checked={prefs.sculptures.includes(option.slug)}
                data-ayatan-sculpture-option={option.slug}
                onchange={() => toggleSculpture(option.slug)}
              />
              {option.label}
            </label>
          {/each}
        </div>
      {/if}
    </div>
    <div class="grid gap-1">
      <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
        >{$translate("browse.ayatan.starsFilter")}</span
      >
      <div class="filter-tabs">
        {#each STARS_OPTIONS as option (option.value)}
          <button
            type="button"
            class="filter-tab"
            class:active={prefs.stars === option.value}
            aria-pressed={prefs.stars === option.value}
            data-ayatan-stars-filter={option.value}
            onclick={() => setStars(option.value)}>{$translate(option.labelKey)}</button
          >
        {/each}
      </div>
    </div>
    <label class="grid gap-1">
      <span class="text-xs uppercase tracking-[0.05em] text-text-muted"
        >{$translate("browse.col.endoPerPlat")}</span
      >
      <input
        class="w-[5.2rem] rounded-[var(--radius-md)] border border-border bg-bg-raised px-[0.4rem] py-[0.3rem] text-[0.78rem] text-text-primary focus:border-accent focus:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_30%,transparent)] focus:outline-none"
        type="number"
        min="0"
        placeholder={$translate("common.min")}
        data-ayatan-min-endo
        bind:value={prefs.minEndoPerPlat}
        oninput={() => (rowLimit = MAX_ROWS)}
      />
    </label>
  </div>

  {#if load.notice}
    <div class="text-xs text-danger" data-ayatan-notice={load.notice.key}>
      {$translate(load.notice.key, {
        count: load.notice.count,
        total: load.notice.total,
        age: load.notice.since != null ? formatLoadAge(load.notice.since, now, $locale) : "",
      })}
    </div>
  {/if}

  {#if !load.hasData && load.pending > 0}
    <div
      class="rounded-xl border border-dashed border-border bg-bg-soft px-4 py-6 text-center text-sm text-text-secondary"
    >
      {$translate("common.loadingListings")}
    </div>
  {:else if !load.hasData && load.failed > 0}
    <div
      class="rounded-xl border border-dashed border-danger/40 bg-bg-soft px-4 py-6 text-center text-sm text-danger"
    >
      {$translate("common.failedToLoadListingsTryAgain")}
    </div>
  {:else if rows.length === 0}
    <div
      class="rounded-xl border border-dashed border-border bg-bg-soft px-4 py-6 text-center text-sm text-text-secondary"
      data-ayatan-empty
    >
      {$translate("browse.noOrdersSell")}
    </div>
  {:else}
    <div class="overflow-x-auto rounded-xl border border-border">
      <table class="w-full border-collapse text-sm">
        <thead>
          <tr
            class="bg-bg-raised text-left text-xs uppercase tracking-[0.05em] text-text-muted [&>th]:px-3 [&>th]:py-2 [&>th]:font-semibold"
          >
            {#each COLUMNS as column (column.key)}
              {@const active = prefs.sortBy === column.key}
              <th
                class={column.alignEnd ? "text-right" : ""}
                data-ayatan-column={column.key}
                aria-sort={active
                  ? prefs.sortDirection === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"}
              >
                <SortHeaderButton
                  label={$translate(column.labelKey)}
                  {active}
                  direction={prefs.sortDirection}
                  alignEnd={column.alignEnd}
                  data-ayatan-sort={column.key}
                  onclick={() => sortByColumn(column.key)}
                />
              </th>
            {/each}
            <th class="text-right">{$translate("browse.col.buy")}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, index (rowKey(row, index))}
            {@const key = rowKey(row, index)}
            {@const ref = catalogBySlug.get(row.slug)}
            {@const label = refLabel(row.slug, $itemDb)}
            <tr
              class="border-t border-border/60 bg-bg-surface transition-colors duration-100 hover:bg-surface-hover [&>td]:px-3 [&>td]:py-2"
              data-ayatan-row
              data-ayatan-slug={row.slug}
            >
              <td>
                <button
                  type="button"
                  class="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-text-primary hover:text-accent"
                  title={$translate("browse.openItem")}
                  data-ayatan-open={row.slug}
                  onclick={() => onOpenItem(row.slug)}
                >
                  <span
                    class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface-card"
                  >
                    <ItemImage
                      src={ref?.thumb ?? null}
                      fallbackSrc={ref?.gameRef ? ($itemDb[ref.gameRef]?.imageUrl ?? null) : null}
                      alt={label}
                      cls="max-h-full max-w-full"
                    />
                  </span>
                  <span class="grid">
                    <span class="font-semibold">{label}</span>
                    <span
                      class="text-[0.68rem] text-text-muted"
                      data-ayatan-stars={row.stars.amber + row.stars.cyan}
                      >{$translate("browse.ayatan.stars", {
                        filled: row.stars.amber + row.stars.cyan,
                        total: row.sockets,
                      })}</span
                    >
                  </span>
                </button>
              </td>
              <td class="text-text-secondary">x{row.entry.quantity}</td>
              <td>
                <button
                  type="button"
                  class="link-btn font-semibold"
                  title={$translate("browse.openProfile")}
                  onclick={() => openProfile(row.entry)}>{row.entry.userName}</button
                >
              </td>
              <td>
                <span
                  class="text-xs font-semibold uppercase tracking-[0.04em] {row.entry.status ===
                  'ingame'
                    ? 'text-success'
                    : row.entry.status === 'online'
                      ? 'text-info'
                      : 'text-text-muted'}"
                  >{$translate(sellerStatusLabelKey(row.entry.status))}</span
                >
              </td>
              <td
                class="text-right font-display text-base font-bold text-text-primary"
                data-ayatan-unit-plat={formatUnitPlatinum(row.entry.unitPlatinum)}
                >{formatUnitPlatinum(row.entry.unitPlatinum)}p{#if row.entry.perTrade > 1}<span
                    class="block text-[0.68rem] font-normal text-text-muted"
                    >{$translate("orderbook.perTrade", {
                      count: row.entry.perTrade,
                      platinum: row.entry.platinum,
                    })}</span
                  >{/if}</td
              >
              <td
                class="text-right font-display text-base font-bold text-accent"
                data-ayatan-endo-per-plat={row.endoPerPlat}
                >{row.endoPerPlat.toLocaleString($locale)}<span
                  class="block text-[0.68rem] font-normal text-text-muted"
                  >{$translate("browse.endoValue", {
                    endo: row.endo.toLocaleString($locale),
                  })}</span
                ></td
              >
              <td class="text-right">
                <button
                  class="{copiedKey === key ? 'btn-success' : 'btn-secondary'} btn-sm min-w-[104px]"
                  title={whisperFor(row, $translate)}
                  onclick={() => void copyWhisper(row, key)}
                  >{copiedKey === key
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
      {$translate("browse.showingSell", { shown: rows.length, total: listings.length })}
      {#if listings.length > rows.length}
        <button class="link-btn" onclick={() => (rowLimit += MAX_ROWS)}
          >{$translate("browse.showMore", {
            n: Math.min(MAX_ROWS, listings.length - rows.length),
          })}</button
        >
      {/if}
    </div>
  {/if}
</div>
