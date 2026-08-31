<script lang="ts">
  import WorkbenchQueueRow from "./WorkbenchQueueRow.svelte";
  import WorkbenchReview from "./WorkbenchReview.svelte";
  import { itemDb, parsedItems, wfmItems } from "../../stores/data.js";
  import {
    inventorySafety,
    resetInventorySafety,
    setItemSpare,
    setSpareDefault,
    toggleSafetyLock,
    toggleSetKeep,
  } from "../../stores/inventorySafety.js";
  import {
    buildSafetyContext,
    safeToList,
    SAFETY_REASON_KEYS,
  } from "../../lib/inventory/safetyRules.js";
  import { setRootOf } from "../../lib/inventory/fullSets.js";
  import { confirmWithDialog, invoke, on, tradeInvoke } from "../../lib/ipc.js";
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import { fetchItemOrderBookBySlug } from "../../lib/wfm/orderBook.js";
  import {
    DEFAULT_DAMPING_RULE,
    WORKBENCH_STRATEGY_IDS,
    type StrategyConfig,
    type WorkbenchStrategyId,
  } from "../../lib/tradeWorkbench/pricingStrategies.js";
  import {
    acknowledgeRowOverride,
    applyStrategy,
    attachMarketData,
    bindingReasonKeys,
    buildPlanFromRows,
    buildQueueRows,
    captureSafetySnapshot,
    planTotals,
    rowNeedsOverride,
    rowSafetyKey,
    setRowQuantity,
    type WorkbenchQueueRow as QueueRow,
  } from "../../lib/tradeWorkbench/queueModel.js";
  import {
    WORKBENCH_MAX_ROWS_PER_RUN,
    type WorkbenchPlanValidation,
    type WorkbenchReviewClassification,
    type WorkbenchReviewReport,
    type WorkbenchState,
  } from "../../../config/shared/tradeWorkbenchTypes.js";
  import type { WfmOrder } from "../../types/market.js";

  // Keys land with this feature's i18n commit; cast until en.json carries them.
  const k = (key: string): MessageKey => key as MessageKey;
  const t = $derived($tr);

  const safetyCtx = $derived(buildSafetyContext({ itemDb: $itemDb, settings: $inventorySafety }));

  let rows = $state<QueueRow[]>([]);
  let built = $state(false);
  let filter = $state("");
  let myOrders = $state<WfmOrder[]>([]);
  let ownUserName = $state<string | null>(null);
  let marketBusy = $state(false);
  let mainState = $state<WorkbenchState | null>(null);
  let reviewReport = $state<WorkbenchReviewReport | null>(null);
  let reviewBusy = $state(false);
  let preview = $state<WorkbenchPlanValidation | null>(null);
  let lastError = $state<string | null>(null);
  let showLegend = $state(false);

  let strategyId = $state<WorkbenchStrategyId>("cheapest-minus-one");
  let percentOffset = $state(-5);
  let averageCount = $state(5);
  let averageThreshold = $state(10);
  let marginCost = $state(0);
  let marginPercent = $state(20);
  let dampMinBelow = $state(DEFAULT_DAMPING_RULE.minListingsBelow);
  let dampMaxPercent = $state(DEFAULT_DAMPING_RULE.maxDropPercent);
  let dampMaxPlat = $state(DEFAULT_DAMPING_RULE.maxDropPlat);

  const dampingRule = $derived({
    minListingsBelow: dampMinBelow,
    maxDropPercent: dampMaxPercent,
    maxDropPlat: dampMaxPlat,
  });

  const visibleRows = $derived(
    rows
      .filter((row) => {
        if (!filter.trim()) return true;
        return row.itemName.toLowerCase().includes(filter.trim().toLowerCase());
      })
      .slice(0, 100),
  );

  const totals = $derived(planTotals(rows));
  const running = $derived(mainState?.phase === "running" || mainState?.phase === "cancelling");
  const reviewRequired = $derived(mainState?.reviewRequired === true);

  $effect(() => {
    void invoke("workbenchGetState").then((state) => {
      mainState = state;
    });
    const dispose = on("workbench-state", (state) => {
      mainState = state;
    });
    return dispose;
  });

  function strategyConfig(): StrategyConfig {
    switch (strategyId) {
      case "percent-offset":
        return { id: "percent-offset", percent: percentOffset };
      case "bounded-cheapest-average":
        return {
          id: "bounded-cheapest-average",
          count: averageCount,
          thresholdPercent: averageThreshold,
        };
      case "target-margin":
        return { id: "target-margin", costPlat: marginCost, marginPercent };
      case "manual":
        return { id: "manual", price: 1 };
      case "match-cheapest":
        return { id: "match-cheapest" };
      default:
        return { id: "cheapest-minus-one" };
    }
  }

  async function buildQueue(): Promise<void> {
    lastError = null;
    const ordersResult = await invoke("wfmGetOrders");
    if ("error" in ordersResult) {
      myOrders = [];
      lastError = ordersResult.error;
    } else {
      myOrders = ordersResult.sell;
    }
    const session = await invoke("wfmGetSession");
    ownUserName = session.loggedIn ? session.userName : null;
    rows = buildQueueRows($parsedItems, safetyCtx, $wfmItems).map((row) =>
      attachMarketData(row, null, null, myOrders),
    );
    built = true;
  }

  /** Recompute verdicts against the live safety settings, keeping edits. */
  function refreshSafety(): void {
    rows = rows.map((row) => {
      const verdict = safeToList(row.item, safetyCtx);
      const next = { ...row, verdict };
      return setRowQuantity(next, Math.min(next.quantity, verdict.total));
    });
  }

  function replaceRow(next: QueueRow): void {
    const index = rows.findIndex((row) => row.rowId === next.rowId);
    if (index >= 0) rows[index] = next;
  }

  async function loadMarketForSelected(): Promise<void> {
    if (marketBusy) return;
    marketBusy = true;
    try {
      // Bounded per click; the order-book cache absorbs repeats.
      const targets = rows.filter((row) => row.selected && !row.sellBook).slice(0, 30);
      for (const target of targets) {
        const result = await fetchItemOrderBookBySlug(target.slug, { rank: target.rank });
        const sell = result.status === "ok" ? result.data.sell : null;
        const buy = result.status === "ok" ? result.data.buy : null;
        const current = rows.find((row) => row.rowId === target.rowId);
        if (!current) continue;
        let next = attachMarketData(current, sell, buy, myOrders);
        next = applyStrategy(next, strategyConfig(), ownUserName, dampingRule);
        replaceRow(next);
      }
    } finally {
      marketBusy = false;
    }
  }

  function applyStrategyToSelected(): void {
    const config = strategyConfig();
    rows = rows.map((row) =>
      row.selected ? applyStrategy(row, config, ownUserName, dampingRule) : row,
    );
  }

  function toggleSelect(row: QueueRow): void {
    replaceRow({ ...row, selected: !row.selected });
  }

  function changeQuantity(row: QueueRow, quantity: number): void {
    replaceRow(setRowQuantity(row, quantity));
  }

  function changeManualPrice(row: QueueRow, price: number | null): void {
    replaceRow({ ...row, manualPrice: price != null && price >= 1 ? Math.round(price) : null });
  }

  function acknowledgeOverride(row: QueueRow): void {
    if (row.overrideAcknowledged) {
      replaceRow({ ...row, overrideAcknowledged: false, overrideAcknowledgedAt: null });
      return;
    }
    const at = Date.now();
    const next = acknowledgeRowOverride(row, at);
    replaceRow(next);
    if (!rowNeedsOverride(next)) return;
    // Audit trail: the acknowledgement is journaled in the main process too.
    void invoke("workbenchAcknowledgeOverride", {
      planId: "queue",
      rowId: next.rowId,
      itemName: next.itemName,
      safeQuantity: next.verdict.safe,
      requestedQuantity: next.quantity,
      reasonKeys: bindingReasonKeys(next.verdict),
      acknowledgedAt: at,
    });
  }

  function previewPlan(): void {
    lastError = null;
    preview = null;
    const now = Date.now();
    const { plan, overCap } = buildPlanFromRows(rows, now);
    if (overCap) {
      lastError = t(k("workbench.error.overCap"), { cap: WORKBENCH_MAX_ROWS_PER_RUN });
      return;
    }
    const planRowIds = new Set(plan.rows.map((row) => row.rowId));
    const snapshot = captureSafetySnapshot(
      rows.filter((row) => planRowIds.has(row.rowId)),
      safetyCtx,
      now,
    );
    void invoke("workbenchPreviewPlan", plan, snapshot).then((result) => {
      if ("error" in result && typeof result.error === "string") lastError = result.error;
      else preview = result as WorkbenchPlanValidation;
    });
  }

  async function executePlan(): Promise<void> {
    lastError = null;
    const now = Date.now();
    const { plan, overCap } = buildPlanFromRows(rows, now);
    if (plan.rows.length === 0 || overCap) {
      lastError = overCap
        ? t(k("workbench.error.overCap"), { cap: WORKBENCH_MAX_ROWS_PER_RUN })
        : t(k("workbench.error.emptyPlan"));
      return;
    }
    const confirmed = await confirmWithDialog(
      t(k("workbench.execute.confirm"), {
        rows: plan.rows.length,
        units: plan.rows.reduce((sum, row) => sum + row.quantity, 0),
      }),
      t,
    );
    if (!confirmed) return;
    // Fresh snapshot at confirm time: the safety engine has the final word.
    const planRowIds = new Set(plan.rows.map((row) => row.rowId));
    const snapshot = captureSafetySnapshot(
      rows.filter((row) => planRowIds.has(row.rowId)),
      safetyCtx,
      Date.now(),
    );
    const result = await tradeInvoke("workbenchExecutePlan", plan, snapshot);
    mainState = result.state;
    if (!result.started) {
      lastError = result.error ?? t(k("workbench.error.notStarted"));
      if (result.validation) preview = result.validation;
    }
  }

  function cancelRun(): void {
    void invoke("workbenchCancelRun").then((state) => {
      mainState = state;
    });
  }

  async function reconcile(): Promise<void> {
    reviewBusy = true;
    try {
      const result = await invoke("workbenchReconcile");
      if ("error" in result && typeof result.error === "string") lastError = result.error;
      else reviewReport = result as WorkbenchReviewReport;
    } finally {
      reviewBusy = false;
    }
  }

  async function resolveReview(
    resolutions: Array<{ intentId: string; classification: WorkbenchReviewClassification }>,
  ): Promise<void> {
    reviewBusy = true;
    try {
      const result = await invoke("workbenchResolveReview", { resolutions });
      if ("error" in result && typeof result.error === "string") lastError = result.error;
      else {
        mainState = result as WorkbenchState;
        reviewReport = null;
      }
    } finally {
      reviewBusy = false;
    }
  }

  async function resetCorruptJournal(): Promise<void> {
    const confirmed = await confirmWithDialog(t(k("workbench.review.resetConfirm")), t);
    if (!confirmed) return;
    const result = await invoke("workbenchResolveReview", {
      resolutions: [],
      resetCorruptJournal: true,
    });
    if (!("error" in result && typeof result.error === "string")) {
      mainState = result as WorkbenchState;
    }
  }

  async function resetSafetySettings(): Promise<void> {
    const confirmed = await confirmWithDialog(t(k("workbench.safety.resetConfirm")), t);
    if (!confirmed) return;
    resetInventorySafety();
    refreshSafety();
  }

  function changeSpare(row: QueueRow, spare: number | null): void {
    setItemSpare(rowSafetyKey(row), spare != null && spare >= 0 ? Math.floor(spare) : null);
    refreshSafety();
  }

  function changeLock(row: QueueRow): void {
    toggleSafetyLock(rowSafetyKey(row));
    refreshSafety();
  }

  function changeSetKeep(row: QueueRow): void {
    toggleSetKeep(setRootOf(row.item.internalName));
    refreshSafety();
  }

  function changeSpareDefault(event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(value) && value >= 0) {
      setSpareDefault(Math.floor(value));
      refreshSafety();
    }
  }

  const doneCount = $derived(
    mainState?.run?.rows.filter((row) => row.status === "done").length ?? 0,
  );
</script>

<section class="flex flex-col gap-3 p-3" data-workbench-panel>
  <header class="flex items-center justify-between">
    <h2 class="text-lg font-semibold">{t(k("workbench.title"))}</h2>
    <div class="flex items-center gap-2 text-xs">
      <label class="flex items-center gap-1">
        {t(k("workbench.safety.spareDefault"))}
        <input
          class="w-12 rounded bg-black/20 px-1 text-right"
          type="number"
          min="0"
          value={$inventorySafety.spareDefault}
          onchange={changeSpareDefault}
        />
      </label>
      <button type="button" class="rounded bg-white/10 px-2 py-0.5" onclick={resetSafetySettings}>
        {t(k("workbench.safety.reset"))}
      </button>
      <button
        type="button"
        class="rounded bg-white/10 px-2 py-0.5"
        onclick={() => (showLegend = !showLegend)}
      >
        {t(k("workbench.safety.legend"))}
      </button>
    </div>
  </header>

  {#if showLegend}
    <ul class="rounded bg-black/20 p-2 text-xs opacity-90">
      {#each SAFETY_REASON_KEYS as reasonKey (reasonKey)}
        <li>{t(k(reasonKey), { count: 1 })}</li>
      {/each}
    </ul>
  {/if}

  {#if lastError}
    <div class="rounded bg-red-500/10 p-2 text-sm text-red-300" data-workbench-error>
      {lastError}
    </div>
  {/if}

  {#if mainState && (reviewRequired || reviewReport)}
    <WorkbenchReview
      wbState={mainState}
      report={reviewReport}
      busy={reviewBusy}
      {t}
      onReconcile={() => void reconcile()}
      onResolve={(resolutions) => void resolveReview(resolutions)}
      onResetCorruptJournal={() => void resetCorruptJournal()}
    />
  {/if}

  <div class="flex flex-wrap items-center gap-2 text-sm">
    <button
      type="button"
      class="rounded bg-white/10 px-2 py-1"
      data-workbench-build
      onclick={() => void buildQueue()}
    >
      {t(k(built ? "workbench.rebuildQueue" : "workbench.buildQueue"))}
    </button>
    <input
      class="w-48 rounded bg-black/20 px-2 py-1"
      placeholder={t(k("workbench.filterPlaceholder"))}
      bind:value={filter}
    />
    <button
      type="button"
      class="rounded bg-white/10 px-2 py-1"
      disabled={marketBusy}
      onclick={() => void loadMarketForSelected()}
    >
      {t(k(marketBusy ? "workbench.loadingMarket" : "workbench.loadMarket"))}
    </button>
    <button type="button" class="rounded bg-white/10 px-2 py-1" onclick={refreshSafety}>
      {t(k("workbench.refreshSafety"))}
    </button>
  </div>

  <div class="flex flex-wrap items-center gap-2 text-xs" data-workbench-strategy>
    <select class="rounded bg-black/20 px-1 py-0.5" bind:value={strategyId}>
      {#each WORKBENCH_STRATEGY_IDS as id (id)}
        <option value={id}>{t(k(`workbench.strategy.${id}`))}</option>
      {/each}
    </select>
    {#if strategyId === "percent-offset"}
      <label
        >{t(k("workbench.strategy.percentLabel"))}
        <input class="w-14 rounded bg-black/20 px-1" type="number" bind:value={percentOffset} />
      </label>
    {:else if strategyId === "bounded-cheapest-average"}
      <label
        >{t(k("workbench.strategy.countLabel"))}
        <input
          class="w-12 rounded bg-black/20 px-1"
          type="number"
          min="1"
          bind:value={averageCount}
        />
      </label>
      <label
        >{t(k("workbench.strategy.thresholdLabel"))}
        <input
          class="w-12 rounded bg-black/20 px-1"
          type="number"
          min="0"
          bind:value={averageThreshold}
        />
      </label>
    {:else if strategyId === "target-margin"}
      <label
        >{t(k("workbench.strategy.costLabel"))}
        <input
          class="w-14 rounded bg-black/20 px-1"
          type="number"
          min="0"
          bind:value={marginCost}
        />
      </label>
      <label
        >{t(k("workbench.strategy.marginLabel"))}
        <input class="w-12 rounded bg-black/20 px-1" type="number" bind:value={marginPercent} />
      </label>
    {/if}
    <span class="opacity-70">{t(k("workbench.damping.title"))}:</span>
    <label
      >{t(k("workbench.damping.minBelow"))}
      <input
        class="w-10 rounded bg-black/20 px-1"
        type="number"
        min="0"
        bind:value={dampMinBelow}
      />
    </label>
    <label
      >{t(k("workbench.damping.maxDropPercent"))}
      <input
        class="w-10 rounded bg-black/20 px-1"
        type="number"
        min="1"
        bind:value={dampMaxPercent}
      />
    </label>
    <label
      >{t(k("workbench.damping.maxDropPlat"))}
      <input class="w-10 rounded bg-black/20 px-1" type="number" min="1" bind:value={dampMaxPlat} />
    </label>
    <button type="button" class="rounded bg-white/10 px-2 py-0.5" onclick={applyStrategyToSelected}>
      {t(k("workbench.applyStrategy"))}
    </button>
  </div>

  {#if built}
    <div class="text-xs opacity-70">
      {t(k("workbench.queueSummary"), { total: rows.length, shown: visibleRows.length })}
    </div>
    <div class="max-h-96 overflow-y-auto" data-workbench-queue>
      {#each visibleRows as row (row.rowId)}
        <WorkbenchQueueRow
          {row}
          canSetKeep={row.item.inventoryGroup === "full_sets"}
          isLocked={$inventorySafety.locks.includes(rowSafetyKey(row))}
          isSetKept={$inventorySafety.setKeep.includes(setRootOf(row.item.internalName))}
          spareOverride={$inventorySafety.spares[rowSafetyKey(row)] ?? null}
          {t}
          onToggleSelect={toggleSelect}
          onQuantity={changeQuantity}
          onManualPrice={changeManualPrice}
          onOverride={acknowledgeOverride}
          onToggleLock={changeLock}
          onToggleSetKeep={changeSetKeep}
          onSpare={changeSpare}
        />
      {/each}
    </div>
  {/if}

  <footer class="flex flex-wrap items-center gap-3 text-sm" data-workbench-footer>
    <span>
      {t(k("workbench.totals"), {
        rows: totals.rows,
        units: totals.units,
        platinum: totals.platinum,
      })}
    </span>
    {#if totals.rows > WORKBENCH_MAX_ROWS_PER_RUN}
      <span class="text-amber-400">
        {t(k("workbench.error.overCap"), { cap: WORKBENCH_MAX_ROWS_PER_RUN })}
      </span>
    {/if}
    <button type="button" class="rounded bg-white/10 px-2 py-1" onclick={previewPlan}>
      {t(k("workbench.preview"))}
    </button>
    <button
      type="button"
      class="rounded bg-emerald-500/30 px-2 py-1"
      disabled={running || reviewRequired || totals.rows === 0}
      data-workbench-execute
      onclick={() => void executePlan()}
    >
      {t(k("workbench.execute"))}
    </button>
    {#if running}
      <button
        type="button"
        class="rounded bg-red-500/30 px-2 py-1"
        data-workbench-cancel
        onclick={cancelRun}
      >
        {t(k(mainState?.phase === "cancelling" ? "workbench.cancelling" : "workbench.cancel"))}
      </button>
    {/if}
  </footer>

  {#if preview}
    <div class="rounded bg-black/20 p-2 text-xs" data-workbench-preview>
      <div>
        {t(k("workbench.previewResult"), {
          units: preview.totalUnits,
          platinum: preview.totalPlatinum,
        })}
        {#if !preview.ok}
          <span class="text-red-300">
            {preview.planError
              ? t(k(`workbench.planError.${preview.planError}`))
              : t(k("workbench.previewInvalid"))}
          </span>
        {/if}
      </div>
      {#each preview.rows.filter((row) => !row.ok) as row (row.rowId)}
        <div class="text-red-300">
          {row.rowId}: {t(k(`workbench.rowError.${row.reason ?? "bad-quantity"}`))}
        </div>
      {/each}
    </div>
  {/if}

  {#if mainState?.run}
    <div class="rounded bg-black/20 p-2 text-xs" data-workbench-progress>
      <div class="mb-1">
        {t(k("workbench.runProgress"), {
          done: doneCount,
          total: mainState.run.rows.length,
        })}
        {#if mainState.run.stopReason}
          · {t(k(`workbench.stopReason.${mainState.run.stopReason}`))}
        {/if}
      </div>
      {#each mainState.run.rows as row (row.rowId)}
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate">{row.itemName}</span>
          <span
            class={row.status === "done"
              ? "text-emerald-300"
              : row.status === "failed" || row.status === "blocked"
                ? "text-red-300"
                : "opacity-70"}
          >
            {t(k(`workbench.rowStatus.${row.status}`))}
          </span>
          {#if row.error}
            <span class="truncate text-red-300" title={row.error}>{row.error}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>
