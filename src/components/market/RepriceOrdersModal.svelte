<script lang="ts">
  import ModalShell from "../ModalShell.svelte";
  import { tr } from "../../lib/i18n.js";
  import { invoke, tradeInvoke } from "../../lib/ipc.js";
  import { fetchRowBook } from "../../lib/tradeWorkbench/rowBook.js";
  import { loadQueueMarketData } from "../../lib/tradeWorkbench/queueModel.js";
  import { STRATEGY_KEYS } from "../../lib/tradeWorkbench/strategyLabels.js";
  import {
    DEFAULT_DAMPING_RULE,
    isMedianStrategy,
    WORKBENCH_STRATEGY_IDS,
    type StrategyConfig,
    type WorkbenchStrategyId,
  } from "../../lib/tradeWorkbench/pricingStrategies.js";
  import { workbenchMedianLoader } from "../../lib/tradeWorkbench/medianReference.js";
  import {
    buildRepriceRows,
    priceRepriceRow,
    repriceRowsToSend,
    repriceTotals,
    runReprice,
    type RepriceRow,
    type RepriceSkipReason,
  } from "../../lib/market/repriceOrders.js";
  import { withinPlatRange, type PlatRange } from "../../lib/market/platRange.js";
  import { numOrUndef } from "../../lib/numberInput.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import type { WfmOrder } from "../../types/market.js";

  let {
    orders,
    onClose,
    onApplied,
  }: {
    orders: WfmOrder[];
    onClose: () => void;
    onApplied: (updates: Array<{ id: string; platinum: number }>) => void;
  } = $props();

  let ownUserName = $state<string | null>(null);
  $effect(() => {
    void invoke("wfmGetSession").then((session) => {
      ownUserName = session.loggedIn ? session.userName : null;
    });
  });

  const SKIP_KEYS: Record<RepriceSkipReason, MessageKey> = {
    "no-book": "market.reprice.skip.noBook",
    "no-price": "market.reprice.skip.noPrice",
    unchanged: "market.reprice.skip.unchanged",
    "not-sell": "market.reprice.skip.notSell",
  };

  const FIELD =
    "rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] " +
    "bg-[var(--ui-control-bg)] px-2 py-1 text-sm text-text-primary";

  // "manual" has no per-row price field here, so it can never decide a price.
  const STRATEGIES = WORKBENCH_STRATEGY_IDS.filter((id) => id !== "manual");

  // svelte-ignore state_referenced_locally
  let rows = $state<RepriceRow[]>(buildRepriceRows(orders));
  let strategyId = $state<WorkbenchStrategyId>("cheapest-minus-one");
  let percentOffset = $state(-5);
  let averageCount = $state(3);
  let averageThreshold = $state(30);
  let medianOffset = $state(0);
  let medianLoads = $state(0);
  let loading = $state(false);
  let loaded = $state(0);
  let loadTotal = $state(0);
  let applying = $state(false);
  let applied = $state(0);
  let failures = $state<string[]>([]);
  let stoppedAuth = $state(false);
  let cancelled = false;

  let filterText = $state("");
  let minPlatRaw = $state<number | null>(null);
  let maxPlatRaw = $state<number | null>(null);
  let showMode = $state<"all" | "changed" | "skipped">("all");

  const strategyConfig = $derived.by<StrategyConfig>(() => {
    if (strategyId === "percent-offset") return { id: "percent-offset", percent: percentOffset };
    if (strategyId === "bounded-cheapest-average") {
      return {
        id: "bounded-cheapest-average",
        count: averageCount,
        thresholdPercent: averageThreshold,
      };
    }
    if (strategyId === "target-margin")
      return { id: "target-margin", costPlat: 0, marginPercent: 0 };
    if (isMedianStrategy(strategyId)) return { id: strategyId, offsetPlat: medianOffset };
    return { id: strategyId } as StrategyConfig;
  });

  const totals = $derived(repriceTotals(rows));
  const priced = $derived(rows.some((row) => row.sellBook !== null));

  const platRange = $derived<PlatRange>({
    min: numOrUndef(minPlatRaw) ?? null,
    max: numOrUndef(maxPlatRaw) ?? null,
  });
  const needle = $derived(filterText.trim().toLowerCase());
  const shownRows = $derived(
    rows.filter((row) => {
      if (needle && !row.label.toLowerCase().includes(needle)) return false;
      if (!withinPlatRange(row.currentPrice, platRange)) return false;
      if (showMode === "changed") return row.skipReason === null && row.nextPrice !== null;
      if (showMode === "skipped") return row.skipReason !== null;
      return true;
    }),
  );
  const selectedCount = $derived(rows.filter((row) => row.selected).length);

  function shownIds(): Set<string> {
    return new Set(shownRows.map((row) => row.rowId));
  }

  // Replaces the selection. Every listing starts selected, so an additive
  // button could never narrow a run down to the filtered rows.
  function selectShown(): void {
    const ids = shownIds();
    rows = rows.map((row) => ({ ...row, selected: ids.has(row.rowId) }));
  }

  function clearSelection(): void {
    rows = rows.map((row) => (row.selected ? { ...row, selected: false } : row));
  }

  function invertShown(): void {
    const ids = shownIds();
    rows = rows.map((row) => (ids.has(row.rowId) ? { ...row, selected: !row.selected } : row));
  }

  function toggleRow(rowId: string, selected: boolean): void {
    const index = rows.findIndex((row) => row.rowId === rowId);
    if (index >= 0) rows[index] = { ...rows[index], selected };
  }

  async function repriceRows(
    rowIds: ReadonlySet<string>,
    isCancelled?: () => boolean,
  ): Promise<void> {
    const config = strategyConfig;
    if (isMedianStrategy(config.id)) {
      medianLoads += 1;
      try {
        await workbenchMedianLoader.load(
          config.id,
          rows.filter((row) => rowIds.has(row.rowId) && row.sellBook !== null),
          isCancelled,
        );
      } finally {
        medianLoads -= 1;
      }
    }
    if (isCancelled?.()) return;
    rows = rows.map((row) =>
      rowIds.has(row.rowId)
        ? priceRepriceRow(
            row,
            config,
            ownUserName,
            DEFAULT_DAMPING_RULE,
            workbenchMedianLoader.peek(config.id, row),
          )
        : row,
    );
  }

  function reprice(): void {
    void repriceRows(new Set(rows.map((row) => row.rowId)));
  }

  async function loadBooks(): Promise<void> {
    if (loading) return;
    // One request per row, so only the selected ones are fetched.
    const pending = rows.filter((row) => row.selected && row.sellBook === null);
    if (pending.length === 0) return;
    loading = true;
    loaded = 0;
    loadTotal = pending.length;
    cancelled = false;
    try {
      await loadQueueMarketData(pending, {
        isCancelled: () => cancelled,
        fetchBook: fetchRowBook,
        onRow: (row, book) => {
          loaded += 1;
          const index = rows.findIndex((entry) => entry.rowId === row.rowId);
          if (index < 0) return;
          const next = { ...rows[index], sellBook: book?.sell ?? null };
          rows[index] = priceRepriceRow(
            next,
            strategyConfig,
            ownUserName,
            DEFAULT_DAMPING_RULE,
            workbenchMedianLoader.peek(strategyConfig.id, next),
          );
        },
      });
      if (isMedianStrategy(strategyConfig.id) && !cancelled) {
        await repriceRows(new Set(pending.map((row) => row.rowId)), () => cancelled);
      }
    } finally {
      loading = false;
    }
  }

  async function apply(): Promise<void> {
    const sending = repriceRowsToSend(rows);
    if (sending.length === 0 || applying) return;
    // Closing destroys the component and invalidates its reactive prop accessors.
    const notifyApplied = onApplied;
    applying = true;
    applied = 0;
    failures = [];
    stoppedAuth = false;
    cancelled = false;
    try {
      const result = await runReprice(sending, {
        updateOrder: (row, platinum) =>
          tradeInvoke("wfmUpdateOrder", row.order.id, {
            platinum,
            quantity: row.order.quantity,
          }),
        isCancelled: () => cancelled,
        isSignedOut: async () => !(await invoke("wfmGetSession")).loggedIn,
        onProgress: (done, failed) => {
          applied = done;
          failures = [...failed];
        },
      });
      stoppedAuth = result.stopReason === "auth";
      // Applied even when the modal closed mid-run; those listings did change price.
      if (result.applied.length > 0) notifyApplied(result.applied);
    } finally {
      applying = false;
    }
  }

  function close(): void {
    cancelled = true;
    onClose();
  }
</script>

<ModalShell ariaLabel={$tr("market.reprice.title")} onClose={close}>
  <div
    class="detail-panel flex max-h-[88vh] w-[900px] max-w-[95vw] flex-col overflow-hidden"
    data-reprice-modal
  >
    <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <h2 class="m-0 font-display text-xl font-bold text-text-primary">
        {$tr("market.reprice.title")}
      </h2>
      <button class="btn-sm btn-secondary" onclick={close}>{$tr("common.close")}</button>
    </header>

    <div class="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
      <label class="flex flex-col gap-1 text-xs text-text-secondary">
        {$tr("workbench.strategyLabel")}
        <select class="{FIELD} w-52" data-reprice-strategy bind:value={strategyId}>
          {#each STRATEGIES as id (id)}
            <option value={id}>{$tr(STRATEGY_KEYS[id])}</option>
          {/each}
        </select>
      </label>
      {#if strategyId === "percent-offset"}
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {$tr("workbench.strategy.percentLabel")}
          <input class="{FIELD} w-20" type="number" bind:value={percentOffset} />
        </label>
      {:else if strategyId === "bounded-cheapest-average"}
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {$tr("workbench.strategy.countLabel")}
          <input class="{FIELD} w-20" type="number" min="1" bind:value={averageCount} />
        </label>
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {$tr("workbench.strategy.thresholdLabel")}
          <input class="{FIELD} w-20" type="number" min="0" bind:value={averageThreshold} />
        </label>
      {:else if isMedianStrategy(strategyId)}
        <label class="flex flex-col gap-1 text-xs text-text-secondary">
          {$tr("workbench.strategy.medianOffsetLabel")}
          <input
            class="{FIELD} w-20"
            type="number"
            step="1"
            data-reprice-median-offset
            bind:value={medianOffset}
          />
        </label>
      {/if}
      <button
        class="btn-secondary btn-sm"
        data-reprice-load
        disabled={loading || applying || medianLoads > 0 || selectedCount === 0}
        onclick={() => void loadBooks()}
      >
        {loading
          ? $tr("market.reprice.loading", { done: String(loaded), total: String(loadTotal) })
          : $tr("market.reprice.loadPrices")}
      </button>
      {#if priced}
        <button
          class="btn-secondary btn-sm"
          disabled={loading || applying || medianLoads > 0}
          onclick={reprice}
        >
          {$tr("workbench.applyStrategy")}
        </button>
      {/if}
    </div>

    <div class="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
      <label class="flex flex-col gap-1 text-xs text-text-secondary">
        {$tr("common.name")}
        <input
          class="{FIELD} w-48"
          type="text"
          data-reprice-filter
          data-search-focus
          placeholder={$tr("common.searchPlaceholder")}
          bind:value={filterText}
        />
      </label>
      <div class="flex flex-col gap-1 text-xs text-text-secondary">
        <span>{$tr("common.platinum")}</span>
        <div class="flex items-center gap-2">
          <label class="flex items-center gap-1">
            {$tr("common.min")}
            <input
              class="{FIELD} w-16"
              type="number"
              min="0"
              data-reprice-min-plat
              bind:value={minPlatRaw}
            />
          </label>
          <label class="flex items-center gap-1">
            {$tr("common.max")}
            <input
              class="{FIELD} w-16"
              type="number"
              min="0"
              data-reprice-max-plat
              bind:value={maxPlatRaw}
            />
          </label>
        </div>
      </div>
      <label class="flex flex-col gap-1 text-xs text-text-secondary">
        {$tr("market.reprice.showLabel")}
        <select class="{FIELD} w-40" data-reprice-show bind:value={showMode}>
          <option value="all">{$tr("common.all")}</option>
          <option value="changed">{$tr("market.reprice.showChanged")}</option>
          <option value="skipped">{$tr("market.reprice.showSkipped")}</option>
        </select>
      </label>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <span class="text-xs text-text-secondary" data-reprice-counts>
          {$tr("market.reprice.counts", {
            shown: String(shownRows.length),
            selected: String(selectedCount),
            total: String(rows.length),
          })}
        </span>
        <button class="btn-secondary btn-sm" data-reprice-select-all onclick={selectShown}>
          {$tr("common.selectMatching", { count: shownRows.length })}
        </button>
        <button class="btn-secondary btn-sm" data-reprice-select-none onclick={clearSelection}>
          {$tr("common.selectNoneCount", { count: selectedCount })}
        </button>
        <button class="btn-secondary btn-sm" data-reprice-select-invert onclick={invertShown}>
          {$tr("common.selectInvert", { count: shownRows.length })}
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
      <div class="text-sm" data-reprice-table>
        <div
          class="grid grid-cols-[1.5rem_1fr_5rem_5rem_12rem] gap-2 pb-1 text-xs uppercase
                 tracking-[0.06em] text-text-muted"
        >
          <span></span>
          <span>{$tr("common.item")}</span>
          <span class="text-right">{$tr("market.reprice.current")}</span>
          <span class="text-right">{$tr("market.reprice.next")}</span>
          <span>{$tr("common.details")}</span>
        </div>
        {#each shownRows as row (row.rowId)}
          <div
            class="grid grid-cols-[1.5rem_1fr_5rem_5rem_12rem] items-center gap-2 border-t
                   border-border py-1"
            data-reprice-row={row.rowId}
          >
            <input
              type="checkbox"
              aria-label={row.label}
              data-reprice-select={row.rowId}
              checked={row.selected}
              onchange={(event) => toggleRow(row.rowId, event.currentTarget.checked)}
            />
            <span class="truncate">{row.label}</span>
            <span class="text-right tabular-nums">{row.currentPrice}</span>
            <span class="text-right tabular-nums">
              {row.nextPrice === null ? "-" : row.nextPrice}
            </span>
            <span class="text-xs text-text-muted">
              {row.skipReason ? $tr(SKIP_KEYS[row.skipReason]) : ""}
            </span>
          </div>
        {/each}
      </div>
    </div>

    <footer class="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
      <span class="text-xs text-text-secondary" data-reprice-summary>
        {$tr("market.reprice.summary", {
          sending: String(totals.sending),
          raised: String(totals.raised),
          lowered: String(totals.lowered),
        })}
      </span>
      {#if failures.length > 0}
        <span class="text-xs text-danger" data-reprice-failed={failures.length}>
          {$tr("market.reprice.failed", { count: String(failures.length) })}
        </span>
      {/if}
      {#if stoppedAuth}
        <span class="text-xs text-danger" data-reprice-stopped>
          {$tr("market.reprice.stoppedAuth")}
        </span>
      {/if}
      <button
        class="btn-primary btn-sm ml-auto"
        data-reprice-apply
        disabled={totals.sending === 0 || applying || loading || medianLoads > 0}
        onclick={() => void apply()}
      >
        {applying
          ? $tr("market.reprice.applying", {
              done: String(applied),
              total: String(totals.sending),
            })
          : $tr("market.reprice.apply", { count: String(totals.sending) })}
      </button>
    </footer>
  </div>
</ModalShell>
