<script lang="ts">
  import type { MessageKey, Translator } from "../../lib/i18n.js";
  import type {
    WorkbenchReviewClassification,
    WorkbenchReviewReport,
    WorkbenchState,
  } from "../../../config/shared/tradeWorkbenchTypes.js";

  interface Props {
    /** Not named `state`: a local binding called state collides with the rune. */
    wbState: WorkbenchState;
    report: WorkbenchReviewReport | null;
    busy: boolean;
    t: Translator;
    onReconcile: () => void;
    onResolve: (
      resolutions: Array<{ intentId: string; classification: WorkbenchReviewClassification }>,
    ) => void;
    onResetCorruptJournal: () => void;
  }

  const { wbState, report, busy, t, onReconcile, onResolve, onResetCorruptJournal }: Props =
    $props();

  // The user may overrule a classification before confirming the repair.
  let picks = $state<Record<string, WorkbenchReviewClassification>>({});

  const CLASSIFICATIONS: readonly WorkbenchReviewClassification[] = [
    "confirmed",
    "failed",
    "unknown",
  ];

  const CLASS_KEYS: Record<WorkbenchReviewClassification, MessageKey> = {
    confirmed: "workbench.review.class.confirmed",
    failed: "workbench.review.class.failed",
    unknown: "workbench.review.class.unknown",
  };

  function pickFor(intentId: string, fallback: WorkbenchReviewClassification) {
    return picks[intentId] ?? fallback;
  }

  // "unknown" never settles an intent, so a row left on it stays open for the
  // next reconcile instead of being silently written off.
  const settlingCount = $derived(
    (report?.rows ?? []).filter((row) => pickFor(row.intentId, row.classification) !== "unknown")
      .length,
  );

  function confirmAll(): void {
    if (!report) return;
    onResolve(
      report.rows
        .map((row) => ({
          intentId: row.intentId,
          classification: pickFor(row.intentId, row.classification),
        }))
        .filter((resolution) => resolution.classification !== "unknown"),
    );
  }
</script>

<div class="rounded border border-warning-dim bg-warning-bg p-3 text-sm" data-workbench-review>
  <div class="mb-2 font-semibold text-warning">{t("workbench.review.title")}</div>
  <p class="mb-2 opacity-80">{t("workbench.review.explanation")}</p>

  {#if wbState.journalError}
    <div class="mb-2 rounded bg-danger-bg p-2 text-danger">
      <div>{t("workbench.review.journalError")}</div>
      <div class="text-xs opacity-80">{wbState.journalError}</div>
      <button
        type="button"
        class="mt-1 rounded bg-danger-bg px-2 py-0.5"
        onclick={onResetCorruptJournal}
      >
        {t("workbench.review.resetJournal")}
      </button>
    </div>
  {/if}

  {#if wbState.unsettledCount > 0}
    <button
      type="button"
      class="rounded bg-surface-hover px-2 py-0.5"
      disabled={busy}
      onclick={onReconcile}
    >
      {t("workbench.review.reconcile")}
    </button>
  {/if}

  {#if report}
    {#if report.fetchError}
      <div class="mt-2 text-danger">
        {t("workbench.review.fetchError")}: {report.fetchError}
      </div>
    {/if}
    <div class="mt-2 space-y-1">
      {#each report.rows as row (row.intentId)}
        <div class="flex items-center gap-2 border-b border-border-subtle py-1">
          <span class="min-w-0 flex-1 truncate">
            {row.itemName} · {row.quantity}x @ {row.platinum}p ({row.mode})
          </span>
          <span
            class="rounded px-1 text-xs {row.classification === 'confirmed'
              ? 'bg-success-bg text-success'
              : row.classification === 'failed'
                ? 'bg-danger-bg text-danger'
                : 'bg-warning-bg text-warning'}"
          >
            {t(CLASS_KEYS[row.classification])}
          </span>
          <select
            class="rounded bg-surface-input px-1 text-xs"
            value={pickFor(row.intentId, row.classification)}
            onchange={(event) => {
              picks[row.intentId] = (event.currentTarget as HTMLSelectElement)
                .value as WorkbenchReviewClassification;
            }}
          >
            {#each CLASSIFICATIONS as classification (classification)}
              <option value={classification}>
                {classification === "unknown"
                  ? t("workbench.review.leaveOpen")
                  : t(CLASS_KEYS[classification])}
              </option>
            {/each}
          </select>
        </div>
      {/each}
    </div>
    {#if report.rows.length > 0}
      <!-- A failed fetch classified nothing, so resolving would settle rows on
           no evidence at all. -->
      <button
        type="button"
        class="mt-2 rounded bg-warning-bg px-2 py-0.5"
        disabled={busy || report.fetchError != null || settlingCount === 0}
        data-workbench-resolve
        onclick={confirmAll}
      >
        {t("workbench.review.confirmResolutions")}
      </button>
    {/if}
  {/if}
</div>
