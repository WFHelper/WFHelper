<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import WorkbenchQueueRow from "./WorkbenchQueueRow.svelte";
  import WorkbenchReview from "./WorkbenchReview.svelte";
  import ModalShell from "../ModalShell.svelte";
  import { parsedItems, wfmItems } from "../../stores/data.js";
  import {
    inventorySafety,
    inventorySafetyContext,
    resetInventorySafety,
    setItemSpare,
    setSpareDefault,
    toggleSafetyLock,
    toggleSetKeep,
  } from "../../stores/inventorySafety.js";
  import { inventorySelection } from "../../stores/inventorySelection.js";
  import { relicDb } from "../../stores/relics.js";
  import { safeToList, SAFETY_REASON_KEYS } from "../../lib/inventory/safetyRules.js";
  import { setRootOf } from "../../lib/inventory/fullSets.js";
  import { confirmWithDialog, invoke, tradeInvoke } from "../../lib/ipc.js";
  import { locale, tr, type MessageKey } from "../../lib/i18n.js";
  import { numOrUndef } from "../../lib/numberInput.js";
  import { fetchItemOrderBookBySlug } from "../../lib/wfm/orderBook.js";
  import {
    DEFAULT_DAMPING_RULE,
    isMedianStrategy,
    WORKBENCH_STRATEGY_IDS,
    type StrategyConfig,
    type WorkbenchStrategyId,
  } from "../../lib/tradeWorkbench/pricingStrategies.js";
  import { workbenchMedianLoader } from "../../lib/tradeWorkbench/medianReference.js";
  import {
    acknowledgeRowOverride,
    applyStrategy,
    attachExistingOrders,
    attachMarketData,
    bindingReasonKeys,
    buildPlanFromRows,
    buildSelectedQueueRows,
    captureSafetySnapshot,
    filterQueueRows,
    loadQueueMarketData,
    mergeQueueRows,
    planTotals,
    rowNeedsOverride,
    rowSafetyKey,
    rowsNeedingMarketData,
    setRowQuantity,
    unpricedHiddenCount,
    unpricedSelectedRows,
    type QueueListedFilter,
    type WorkbenchQueueRow as QueueRow,
  } from "../../lib/tradeWorkbench/queueModel.js";
  import {
    markQueueMarketFetched,
    readCachedQueueRows,
    writeCachedQueueRows,
  } from "../../lib/tradeWorkbench/queueCache.js";
  import { STRATEGY_KEYS } from "../../lib/tradeWorkbench/strategyLabels.js";
  import { setWorkbenchState, workbenchState } from "../../lib/tradeWorkbench/workbenchState.js";
  import {
    WORKBENCH_MAX_ROWS_PER_RUN,
    type WorkbenchPlanValidation,
    type WorkbenchReviewClassification,
    type WorkbenchReviewReport,
    type WorkbenchRowProgress,
    type WorkbenchState,
    type WorkbenchStopReason,
  } from "../../../config/shared/tradeWorkbenchTypes.js";
  import type { WfmOrder } from "../../types/market.js";

  interface Props {
    onClose: () => void;
  }

  const { onClose }: Props = $props();

  const t = $derived($tr);

  const PLAN_ERROR_KEYS: Record<NonNullable<WorkbenchPlanValidation["planError"]>, MessageKey> = {
    empty: "workbench.planError.empty",
    "too-many-rows": "workbench.planError.too-many-rows",
    "duplicate-row-ids": "workbench.planError.duplicate-row-ids",
  };

  const ROW_ERROR_KEYS: Record<
    NonNullable<WorkbenchPlanValidation["rows"][number]["reason"]>,
    MessageKey
  > = {
    "missing-safety": "workbench.rowError.missing-safety",
    "over-safe": "workbench.rowError.over-safe",
    "over-total": "workbench.rowError.over-total",
    "bad-quantity": "workbench.rowError.bad-quantity",
    "bad-price": "workbench.rowError.bad-price",
    "missing-order-id": "workbench.rowError.missing-order-id",
  };

  const STOP_REASON_KEYS: Record<WorkbenchStopReason, MessageKey> = {
    completed: "workbench.stopReason.completed",
    cancelled: "workbench.stopReason.cancelled",
    "order-limit": "workbench.stopReason.order-limit",
    auth: "workbench.stopReason.auth",
    error: "workbench.stopReason.error",
  };

  const ROW_STATUS_KEYS: Record<WorkbenchRowProgress["status"], MessageKey> = {
    pending: "workbench.rowStatus.pending",
    "in-flight": "workbench.rowStatus.in-flight",
    done: "workbench.rowStatus.done",
    failed: "workbench.rowStatus.failed",
    cancelled: "workbench.rowStatus.cancelled",
    blocked: "workbench.rowStatus.blocked",
  };

  // Rows named one by one in the confirm dialog; main truncates the message.
  const CONFIRM_ROW_PREVIEW = 8;

  // Display only. Bulk ticks cover every filtered row, not this slice.
  const QUEUE_DISPLAY_CAP = 100;

  const FIELD_CLASS =
    "rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] " +
    "bg-[var(--ui-control-bg)] px-2 py-1.5 text-sm text-text-primary outline-none " +
    "focus:border-accent-dim";
  const LABEL_CLASS =
    "flex flex-col gap-1 font-display text-xs uppercase tracking-[0.04em] text-text-muted";

  const safetyCtx = $derived($inventorySafetyContext);

  let rows = $state<QueueRow[]>([]);
  let filter = $state("");
  let minPlat = $state<number | null>(null);
  let maxPlat = $state<number | null>(null);
  let listedFilter = $state<QueueListedFilter>("all");
  let myOrders = $state<WfmOrder[]>([]);
  /** False until a fetch of our own orders succeeded; every row would otherwise
   *  be planned as a create and duplicate whatever is already listed. */
  let ordersReady = $state(false);
  let ordersBusy = $state(false);
  let ownUserName = $state<string | null>(null);
  let marketBusy = $state(false);
  let marketDone = $state(0);
  let marketTotal = $state(0);
  let marketFailedRowIds = $state<readonly string[]>([]);
  let marketAbort = false;
  let reviewReport = $state<WorkbenchReviewReport | null>(null);
  let reviewBusy = $state(false);
  let preview = $state<WorkbenchPlanValidation | null>(null);
  let lastError = $state<string | null>(null);
  let loggedIn = $state(true);
  let showLegend = $state(false);

  // Captured at init: the persist effect below flushes on mount, so it would
  // overwrite the cache with the empty starting rows before the async open reads it.
  const restoredRows = readCachedQueueRows();
  let queueBuilt = $state(false);

  let strategyId = $state<WorkbenchStrategyId>("cheapest-minus-one");
  let percentOffset = $state(-5);
  let averageCount = $state(5);
  let averageThreshold = $state(10);
  let marginCost = $state(0);
  let marginPercent = $state(20);
  let medianOffset = $state(0);
  let medianLoads = $state(0);
  // Per row the newest apply wins, so a slow median load never overwrites a later one.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const rowApplyTokens = new Map<string, number>();
  let applyCounter = 0;
  let dampMinBelow = $state(DEFAULT_DAMPING_RULE.minListingsBelow);
  let dampMaxPercent = $state(DEFAULT_DAMPING_RULE.maxDropPercent);
  let dampMaxPlat = $state(DEFAULT_DAMPING_RULE.maxDropPlat);

  const dampingRule = $derived({
    minListingsBelow: dampMinBelow,
    maxDropPercent: dampMaxPercent,
    maxDropPlat: dampMaxPlat,
  });

  const queueFilter = $derived({
    text: filter,
    plat: { min: numOrUndef(minPlat) ?? null, max: numOrUndef(maxPlat) ?? null },
    listed: listedFilter,
  });
  const filteredRows = $derived(filterQueueRows(rows, queueFilter));
  const visibleRows = $derived(filteredRows.slice(0, QUEUE_DISPLAY_CAP));
  const noPriceHidden = $derived(unpricedHiddenCount(rows, queueFilter));
  const selectedCount = $derived(rows.filter((row) => row.selected).length);

  const totals = $derived(planTotals(rows));
  const previewFailures = $derived(
    (preview?.rows ?? [])
      .filter((row) => !row.ok)
      .map((row) => ({
        ...row,
        name: rows.find((queued) => queued.rowId === row.rowId)?.itemName ?? row.rowId,
      })),
  );
  const unpricedCount = $derived(unpricedSelectedRows(rows).length);
  const mainState = $derived($workbenchState);
  const running = $derived(mainState?.phase === "running" || mainState?.phase === "cancelling");
  const reviewRequired = $derived(mainState?.reviewRequired === true);

  // Built once on open: the queue is the snapshot of what the user ticked, so a
  // later inventory push must not drop rows they are already pricing.
  onMount(() => {
    void openQueue();
  });

  // Survives a close/reopen for as long as the app runs, so reopening an
  // unchanged selection keeps its loaded order books and applied prices. Held
  // back until the queue exists, or a failed open would discard the cache.
  $effect(() => {
    if (queueBuilt) writeCachedQueueRows(rows);
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
        return { id: "manual" };
      case "match-cheapest":
        return { id: "match-cheapest" };
      case "median-48h":
      case "median-90d":
        return { id: strategyId, offsetPlat: medianOffset };
      default:
        return { id: "cheapest-minus-one" };
    }
  }

  async function loadOwnOrders(): Promise<boolean> {
    ordersBusy = true;
    try {
      const ordersResult = await invoke("wfmGetOrders");
      if ("error" in ordersResult) {
        myOrders = [];
        ordersReady = false;
        lastError = ordersResult.error;
        return false;
      }
      myOrders = ordersResult.sell;
      ordersReady = true;
      return true;
    } finally {
      ordersBusy = false;
    }
  }

  /** Re-reads the account orders after a failed fetch and re-joins the queue to
   *  them, so carried rows stop claiming they are unlisted. */
  async function retryOwnOrders(): Promise<void> {
    lastError = null;
    if (!(await loadOwnOrders())) return;
    rows = attachExistingOrders(rows, myOrders);
  }

  async function openQueue(): Promise<void> {
    lastError = null;
    const session = await invoke("wfmGetSession");
    loggedIn = session.loggedIn;
    ownUserName = session.loggedIn ? session.userName : null;
    if (session.loggedIn) {
      await loadOwnOrders();
    } else {
      // Logged out is a standing state, not an error: the persistent hint
      // below owns it and the execute button stays disabled.
      myOrders = [];
      ordersReady = false;
    }
    // The existing order is always re-read from the fresh account orders, so a
    // carried row still reports what is listed right now.
    const built = buildSelectedQueueRows(
      $parsedItems,
      safetyCtx,
      $wfmItems,
      $inventorySelection,
      (uniqueName) => $relicDb?.byUniqueName[uniqueName]?.quality ?? null,
    ).map((row) => attachMarketData(row, null, null, myOrders));
    rows = mergeQueueRows(restoredRows, built);
    queueBuilt = true;
  }

  /** Recompute verdicts against the live safety settings, keeping edits. */
  function refreshSafety(): void {
    rows = rows.map((row) => {
      const verdict = safeToList(row.item, safetyCtx);
      const next = { ...row, verdict };
      // setRowQuantity clamps to the new verdict's total on its own.
      return setRowQuantity(next, next.quantity);
    });
  }

  function replaceRow(next: QueueRow): void {
    const index = rows.findIndex((row) => row.rowId === next.rowId);
    if (index >= 0) rows[index] = next;
  }

  async function loadMarketForSelected(): Promise<void> {
    if (marketBusy) return;
    const targets = rowsNeedingMarketData(rows);
    if (targets.length === 0) return;
    marketBusy = true;
    marketAbort = false;
    marketDone = 0;
    marketTotal = targets.length;
    marketFailedRowIds = [];
    try {
      const summary = await loadQueueMarketData(targets, {
        isCancelled: () => marketAbort,
        fetchBook: async (target) => {
          const result = await fetchItemOrderBookBySlug(target.slug, {
            rank: target.rank,
            priority: "background",
          });
          return result.status === "ok" ? { sell: result.data.sell, buy: result.data.buy } : null;
        },
        onRow: (target, book) => {
          marketDone += 1;
          const current = rows.find((row) => row.rowId === target.rowId);
          if (!current) return;
          const config = strategyConfig();
          claimRows([target.rowId]);
          let next = attachMarketData(current, book?.sell ?? null, book?.buy ?? null, myOrders);
          next = applyStrategy(
            next,
            config,
            ownUserName,
            dampingRule,
            workbenchMedianLoader.peek(config.id, next),
          );
          replaceRow(next);
          if (book?.sell) markQueueMarketFetched();
        },
      });
      marketFailedRowIds = summary.failedRowIds;
      const config = strategyConfig();
      if (isMedianStrategy(config.id) && !marketAbort) {
        await applyConfigToRows(
          config,
          new Set(targets.map((target) => target.rowId)),
          () => marketAbort,
        );
      }
    } finally {
      marketBusy = false;
    }
  }

  const marketFailedNames = $derived(
    rows.filter((row) => marketFailedRowIds.includes(row.rowId)).map((row) => row.itemName),
  );

  onDestroy(() => {
    marketAbort = true;
  });

  function claimRows(rowIds: Iterable<string>): number {
    const token = ++applyCounter;
    for (const rowId of rowIds) rowApplyTokens.set(rowId, token);
    return token;
  }

  async function applyConfigToRows(
    config: StrategyConfig,
    rowIds: ReadonlySet<string>,
    isCancelled?: () => boolean,
  ): Promise<void> {
    const token = claimRows(rowIds);
    if (isMedianStrategy(config.id)) {
      medianLoads += 1;
      try {
        await workbenchMedianLoader.load(
          config.id,
          rows.filter((row) => rowIds.has(row.rowId) && row.sellBook),
          isCancelled,
        );
      } finally {
        medianLoads -= 1;
      }
    }
    if (isCancelled?.()) return;
    rows = rows.map((row) =>
      rowIds.has(row.rowId) && rowApplyTokens.get(row.rowId) === token
        ? applyStrategy(
            row,
            config,
            ownUserName,
            dampingRule,
            workbenchMedianLoader.peek(config.id, row),
          )
        : row,
    );
  }

  function applyStrategyToSelected(): void {
    const selected = new Set(rows.filter((row) => row.selected).map((row) => row.rowId));
    void applyConfigToRows(strategyConfig(), selected);
  }

  function toggleSelect(row: QueueRow): void {
    replaceRow({ ...row, selected: !row.selected });
  }

  function selectFiltered(next: (row: QueueRow) => boolean): void {
    const ids = new Set(filteredRows.map((row) => row.rowId));
    rows = rows.map((row) => (ids.has(row.rowId) ? { ...row, selected: next(row) } : row));
  }

  /** Clears hidden rows too, or a filtered-out tick would still be listed. */
  function clearSelection(): void {
    rows = rows.map((row) => (row.selected ? { ...row, selected: false } : row));
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

  /** Two clicks can resolve out of order, so only the newest preview writes. */
  let previewToken = 0;

  function previewPlan(): void {
    lastError = null;
    preview = null;
    const token = ++previewToken;
    const now = Date.now();
    const { plan, overCap } = buildPlanFromRows(rows, now, myOrders);
    if (overCap) {
      lastError = t("workbench.error.overCap", { cap: WORKBENCH_MAX_ROWS_PER_RUN });
      return;
    }
    const planRowIds = new Set(plan.rows.map((row) => row.rowId));
    const snapshot = captureSafetySnapshot(
      rows.filter((row) => planRowIds.has(row.rowId)),
      safetyCtx,
      now,
    );
    void invoke("workbenchPreviewPlan", plan, snapshot).then((result) => {
      if (token !== previewToken) return;
      if ("error" in result && typeof result.error === "string") lastError = result.error;
      else preview = result as WorkbenchPlanValidation;
    });
  }

  async function executePlan(): Promise<void> {
    lastError = null;
    const now = Date.now();
    const { plan, overCap } = buildPlanFromRows(rows, now, myOrders);
    if (plan.rows.length === 0 || overCap) {
      lastError = overCap
        ? t("workbench.error.overCap", { cap: WORKBENCH_MAX_ROWS_PER_RUN })
        : t("workbench.error.emptyPlan");
      return;
    }
    const prices = plan.rows.map((row) => row.platinum);
    const confirmed = await confirmWithDialog(
      [
        t("workbench.execute.confirm", {
          rows: plan.rows.length,
          units: plan.rows.reduce((sum, row) => sum + row.quantity, 0),
        }),
        // Prices are what a mispriced plan is spotted by, so they belong in the
        // last dialog before anything is listed.
        t("workbench.execute.confirmPricing", {
          platinum: plan.rows.reduce((sum, row) => sum + row.quantity * row.platinum, 0),
          min: Math.min(...prices),
          max: Math.max(...prices),
        }),
        ...plan.rows.slice(0, CONFIRM_ROW_PREVIEW).map((row) =>
          t("workbench.execute.confirmRow", {
            item: row.itemName,
            units: row.quantity,
            price: row.platinum,
          }),
        ),
        ...(plan.rows.length > CONFIRM_ROW_PREVIEW
          ? [
              t("workbench.execute.confirmMoreRows", {
                count: plan.rows.length - CONFIRM_ROW_PREVIEW,
              }),
            ]
          : []),
      ].join("\n"),
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
    setWorkbenchState(result.state);
    if (!result.started) {
      lastError = result.error ?? t("workbench.error.notStarted");
      if (result.validation) preview = result.validation;
    }
  }

  function cancelRun(): void {
    void invoke("workbenchCancelRun").then(setWorkbenchState);
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
        setWorkbenchState(result as WorkbenchState);
        reviewReport = null;
      }
    } finally {
      reviewBusy = false;
    }
  }

  async function resetCorruptJournal(): Promise<void> {
    const confirmed = await confirmWithDialog(t("workbench.review.resetConfirm"), t);
    if (!confirmed) return;
    const result = await invoke("workbenchResolveReview", {
      resolutions: [],
      resetCorruptJournal: true,
    });
    if (!("error" in result && typeof result.error === "string")) {
      setWorkbenchState(result as WorkbenchState);
    }
  }

  async function resetSafetySettings(): Promise<void> {
    const confirmed = await confirmWithDialog(t("workbench.safety.resetConfirm"), t);
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

  const run = $derived(mainState?.run ?? null);
  const doneCount = $derived(run?.rows.filter((row) => row.status === "done").length ?? 0);
  const runFinishedAt = $derived(run?.finishedAt ?? null);
  const runFinishedLabel = $derived(
    runFinishedAt != null ? new Date(runFinishedAt).toLocaleString($locale) : "",
  );

  let watchedRunPlanId: string | null = null;
  let refreshedRunPlanId: string | null = null;

  async function refreshOrdersAfterRun(): Promise<void> {
    if (!(await loadOwnOrders())) return;
    rows = attachExistingOrders(rows, myOrders);
  }

  $effect(() => {
    const progress = run;
    if (!progress) return;
    if (progress.finishedAt == null) {
      watchedRunPlanId = progress.planId;
      return;
    }
    if (running || !loggedIn) return;
    if (watchedRunPlanId !== progress.planId || refreshedRunPlanId === progress.planId) return;
    refreshedRunPlanId = progress.planId;
    void refreshOrdersAfterRun();
  });
</script>

<ModalShell ariaLabel={t("workbench.title")} {onClose}>
  <div
    class="detail-panel flex max-h-[88vh] w-[1180px] max-w-[95vw] flex-col overflow-hidden"
    data-bulk-sell-modal
  >
    <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <h2 class="m-0 font-display text-xl font-bold text-text-primary">
        {t("workbench.title")}
      </h2>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-2 text-xs text-text-muted">
          {t("workbench.safety.spareDefault")}
          <input
            class="{FIELD_CLASS} w-16 text-right"
            type="number"
            min="0"
            value={$inventorySafety.spareDefault}
            onchange={changeSpareDefault}
          />
        </label>
        <button type="button" class="btn-secondary btn-sm" onclick={resetSafetySettings}>
          {t("workbench.safety.reset")}
        </button>
        <button
          type="button"
          class="btn-secondary btn-sm"
          aria-pressed={showLegend}
          onclick={() => (showLegend = !showLegend)}
        >
          {t("workbench.safety.legend")}
        </button>
        <button type="button" class="detail-close" aria-label={t("common.close")} onclick={onClose}
          >&times;</button
        >
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      {#if showLegend}
        <!-- Own scroll box: the legend is a reference list, so it must not push
             the queue it explains out of the modal body. -->
        <section
          class="shrink-0 rounded-[var(--radius-md)] border border-border bg-surface-card p-3"
          data-workbench-legend
        >
          <h3
            class="m-0 mb-1.5 font-display text-xs font-bold uppercase tracking-[0.06em] text-text-secondary"
          >
            {t("workbench.safety.legend")}
          </h3>
          <ul class="m-0 grid max-h-40 gap-1 overflow-y-auto pr-1 text-xs text-text-secondary">
            {#each SAFETY_REASON_KEYS as reasonKey (reasonKey)}
              <li>{t(reasonKey, { count: 1 })}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if !loggedIn}
        <div
          class="rounded-[var(--radius-md)] border border-warning/40 bg-warning/10 p-2.5 text-sm text-warning"
          data-workbench-signin-hint
        >
          {t("workbench.signInHint")}
        </div>
      {/if}

      {#if loggedIn && !ordersReady}
        <div
          class="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-danger/40 bg-danger/10 p-2.5 text-sm text-danger"
          data-workbench-orders-error
        >
          <span>{t("workbench.ordersFetchFailed")}</span>
          <button
            type="button"
            class="btn-secondary btn-sm"
            disabled={ordersBusy}
            data-workbench-orders-retry
            onclick={() => void retryOwnOrders()}
          >
            {t("common.retry")}
          </button>
        </div>
      {/if}

      {#if safetyCtx.degradedRules.length > 0}
        <div
          class="rounded-[var(--radius-md)] border border-warning/40 bg-warning/10 p-2.5 text-sm text-warning"
          data-workbench-degraded
        >
          {t("workbench.safety.degradedRules", { rules: safetyCtx.degradedRules.join(", ") })}
        </div>
      {/if}

      {#if lastError}
        <div
          class="rounded-[var(--radius-md)] border border-danger/40 bg-danger/10 p-2.5 text-sm text-danger"
          data-workbench-error
        >
          {lastError}
        </div>
      {/if}

      {#if marketFailedNames.length > 0}
        <div
          class="rounded-[var(--radius-md)] border border-warning/40 bg-warning/10 p-2.5 text-sm text-warning"
          data-workbench-price-failed={marketFailedNames.length}
        >
          <div>{t("workbench.marketFailed", { count: marketFailedNames.length })}</div>
          <div class="mt-1 max-h-16 overflow-y-auto text-xs">{marketFailedNames.join(", ")}</div>
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

      <div class="flex flex-wrap items-center gap-3">
        <input
          class="{FIELD_CLASS} w-56"
          placeholder={t("workbench.filterPlaceholder")}
          aria-label={t("workbench.filterPlaceholder")}
          data-workbench-filter
          bind:value={filter}
        />
        <input
          class="{FIELD_CLASS} w-24 text-right"
          type="number"
          min="0"
          placeholder={t("workbench.filter.minPlat")}
          aria-label={t("workbench.filter.minPlat")}
          data-workbench-min-plat
          bind:value={minPlat}
        />
        <input
          class="{FIELD_CLASS} w-24 text-right"
          type="number"
          min="0"
          placeholder={t("workbench.filter.maxPlat")}
          aria-label={t("workbench.filter.maxPlat")}
          data-workbench-max-plat
          bind:value={maxPlat}
        />
        <select
          class="{FIELD_CLASS} w-44"
          aria-label={t("workbench.filter.listedLabel")}
          data-workbench-listed
          bind:value={listedFilter}
        >
          <option value="all">{t("workbench.filter.listedAll")}</option>
          <option value="unlisted">{t("workbench.filter.listedUnlisted")}</option>
          <option value="listed">{t("workbench.filter.listedListed")}</option>
        </select>
        {#if noPriceHidden > 0}
          <span class="text-xs text-warning" data-workbench-no-price-hidden={noPriceHidden}>
            {t("workbench.filter.noPriceHidden", { count: noPriceHidden })}
          </span>
        {/if}
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn-secondary btn-sm"
          disabled={filteredRows.length === 0}
          data-workbench-select-all
          onclick={() => selectFiltered(() => true)}
        >
          {t("common.selectMatching", { count: filteredRows.length })}
        </button>
        <button
          type="button"
          class="btn-secondary btn-sm"
          disabled={selectedCount === 0}
          data-workbench-select-none
          onclick={clearSelection}
        >
          {t("common.selectNoneCount", { count: selectedCount })}
        </button>
        <button
          type="button"
          class="btn-secondary btn-sm"
          disabled={filteredRows.length === 0}
          data-workbench-select-invert
          onclick={() => selectFiltered((row) => !row.selected)}
        >
          {t("common.selectInvert", { count: filteredRows.length })}
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="btn-secondary"
          disabled={marketBusy}
          data-workbench-load-market
          onclick={() => void loadMarketForSelected()}
        >
          {t(marketBusy ? "workbench.loadingMarket" : "workbench.loadMarket")}
        </button>
        {#if marketTotal > 0}
          <span
            class="text-xs text-text-muted"
            data-workbench-price-progress="{marketDone}/{marketTotal}"
          >
            {t("workbench.marketProgress", { done: marketDone, total: marketTotal })}
          </span>
        {/if}
        {#if marketBusy}
          <button
            type="button"
            class="btn-secondary btn-sm"
            data-workbench-price-stop
            onclick={() => (marketAbort = true)}
          >
            {t("workbench.stopLoadingMarket")}
          </button>
        {/if}
        <button type="button" class="btn-secondary" onclick={refreshSafety}>
          {t("workbench.refreshSafety")}
        </button>
      </div>

      <div class="grid gap-3 md:grid-cols-2" data-workbench-strategy>
        <fieldset
          class="flex flex-wrap items-end gap-3 rounded-[var(--radius-md)] border border-border p-3"
        >
          <legend class="px-1 font-display text-xs uppercase tracking-[0.06em] text-text-secondary">
            {t("workbench.section.pricing")}
          </legend>
          <label class={LABEL_CLASS}>
            {t("workbench.strategyLabel")}
            <select class="{FIELD_CLASS} w-52" bind:value={strategyId}>
              {#each WORKBENCH_STRATEGY_IDS as id (id)}
                <option value={id}>{t(STRATEGY_KEYS[id])}</option>
              {/each}
            </select>
          </label>
          {#if strategyId === "percent-offset"}
            <label class={LABEL_CLASS}>
              {t("workbench.strategy.percentLabel")}
              <input class="{FIELD_CLASS} w-20" type="number" bind:value={percentOffset} />
            </label>
          {:else if strategyId === "bounded-cheapest-average"}
            <label class={LABEL_CLASS}>
              {t("workbench.strategy.countLabel")}
              <input class="{FIELD_CLASS} w-20" type="number" min="1" bind:value={averageCount} />
            </label>
            <label class={LABEL_CLASS}>
              {t("workbench.strategy.thresholdLabel")}
              <input
                class="{FIELD_CLASS} w-20"
                type="number"
                min="0"
                bind:value={averageThreshold}
              />
            </label>
          {:else if strategyId === "target-margin"}
            <label class={LABEL_CLASS}>
              {t("workbench.strategy.costLabel")}
              <input class="{FIELD_CLASS} w-20" type="number" min="0" bind:value={marginCost} />
            </label>
            <label class={LABEL_CLASS}>
              {t("workbench.strategy.marginLabel")}
              <input class="{FIELD_CLASS} w-20" type="number" bind:value={marginPercent} />
            </label>
          {:else if isMedianStrategy(strategyId)}
            <label class={LABEL_CLASS}>
              {t("workbench.strategy.medianOffsetLabel")}
              <input
                class="{FIELD_CLASS} w-20"
                type="number"
                step="1"
                data-workbench-median-offset
                bind:value={medianOffset}
              />
            </label>
          {/if}
          <button
            type="button"
            class="btn-secondary"
            disabled={medianLoads > 0}
            data-workbench-apply-strategy
            onclick={applyStrategyToSelected}
          >
            {t("workbench.applyStrategy")}
          </button>
        </fieldset>

        <fieldset
          class="flex flex-wrap items-end gap-3 rounded-[var(--radius-md)] border border-border p-3"
        >
          <legend class="px-1 font-display text-xs uppercase tracking-[0.06em] text-text-secondary">
            {t("workbench.damping.title")}
          </legend>
          <label class={LABEL_CLASS}>
            {t("workbench.damping.minBelow")}
            <input class="{FIELD_CLASS} w-20" type="number" min="0" bind:value={dampMinBelow} />
          </label>
          <label class={LABEL_CLASS}>
            {t("workbench.damping.maxDropPercent")}
            <input class="{FIELD_CLASS} w-20" type="number" min="1" bind:value={dampMaxPercent} />
          </label>
          <label class={LABEL_CLASS}>
            {t("workbench.damping.maxDropPlat")}
            <input class="{FIELD_CLASS} w-20" type="number" min="1" bind:value={dampMaxPlat} />
          </label>
        </fieldset>
      </div>

      {#if rows.length === 0}
        <p class="py-6 text-center text-sm text-text-muted" data-workbench-empty>
          {t("workbench.queueEmpty")}
        </p>
      {:else}
        <div class="text-xs text-text-muted">
          {t("workbench.queueSummary", {
            total: rows.length,
            shown: visibleRows.length,
            selected: selectedCount,
          })}
        </div>
        <div class="grid gap-1" data-workbench-queue>
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

      {#if previewFailures.length > 0}
        <div
          class="rounded-[var(--radius-md)] border border-border bg-surface-card p-2.5 text-xs"
          data-workbench-preview
        >
          {#each previewFailures as row (row.rowId)}
            <div class="text-danger">
              {row.name}: {t(ROW_ERROR_KEYS[row.reason ?? "bad-quantity"])}
            </div>
          {/each}
        </div>
      {/if}

      {#if run}
        <div
          class="rounded-[var(--radius-md)] border border-border bg-surface-card p-2.5 text-xs"
          data-workbench-progress
          data-workbench-run-state={runFinishedAt != null ? "finished" : "running"}
        >
          <div class="mb-1 font-semibold">
            {#if runFinishedAt != null}
              <span class="text-text-muted">
                {t("workbench.lastRunAt", { at: runFinishedLabel })} ·
              </span>
            {/if}
            {t("workbench.runProgress", {
              done: doneCount,
              total: run.rows.length,
            })}
            {#if run.stopReason}
              · {t(STOP_REASON_KEYS[run.stopReason])}
            {/if}
          </div>
          {#each run.rows as row (row.rowId)}
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate">{row.itemName}</span>
              <span
                class={row.status === "done"
                  ? "text-success"
                  : row.status === "failed" || row.status === "blocked"
                    ? "text-danger"
                    : "text-text-muted"}
              >
                {t(ROW_STATUS_KEYS[row.status])}
              </span>
              {#if row.error}
                <span class="truncate text-danger" title={row.error}>{row.error}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <footer
      class="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3"
      data-workbench-footer
    >
      <span class="text-sm text-text-secondary">
        {t("workbench.totals", {
          rows: totals.rows,
          units: totals.units,
          platinum: totals.platinum,
        })}
      </span>
      {#if totals.rows > WORKBENCH_MAX_ROWS_PER_RUN}
        <span class="text-sm text-warning">
          {t("workbench.error.overCap", { cap: WORKBENCH_MAX_ROWS_PER_RUN })}
        </span>
      {/if}
      {#if unpricedCount > 0}
        <span class="text-sm text-danger" data-workbench-unpriced>
          {t("workbench.error.unpricedRows", { count: unpricedCount })}
        </span>
      {/if}
      {#if preview}
        <span
          class={preview.ok ? "text-sm text-text-secondary" : "text-sm text-danger"}
          data-workbench-preview-summary={preview.ok ? "ok" : "invalid"}
        >
          {t("workbench.previewResult", {
            units: preview.totalUnits,
            platinum: preview.totalPlatinum,
          })}
          {#if !preview.ok}
            {preview.planError
              ? t(PLAN_ERROR_KEYS[preview.planError])
              : t("workbench.previewInvalid")}
          {/if}
        </span>
      {/if}
      <div class="ml-auto flex items-center gap-2">
        <button
          type="button"
          class="btn-secondary"
          data-workbench-preview-btn
          onclick={previewPlan}
        >
          {t("workbench.preview")}
        </button>
        {#if running}
          <button type="button" class="btn-danger" data-workbench-cancel onclick={cancelRun}>
            {t(mainState?.phase === "cancelling" ? "workbench.cancelling" : "workbench.cancel")}
          </button>
        {/if}
        <button
          type="button"
          class="btn-primary px-6 py-2.5 text-base"
          disabled={!loggedIn ||
            !ordersReady ||
            ordersBusy ||
            running ||
            medianLoads > 0 ||
            reviewRequired ||
            unpricedCount > 0 ||
            totals.rows === 0}
          title={!loggedIn ? t("workbench.signInHint") : undefined}
          data-workbench-execute
          onclick={() => void executePlan()}
        >
          {t("workbench.execute")}
        </button>
      </div>
    </footer>
  </div>
</ModalShell>
