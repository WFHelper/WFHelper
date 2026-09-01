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

  // Keys land with this feature's i18n commit; cast until en.json carries them.
  const k = (key: string): MessageKey => key as MessageKey;

  // The user may overrule a classification before confirming the repair.
  let picks = $state<Record<string, WorkbenchReviewClassification>>({});

  const CLASSIFICATIONS: readonly WorkbenchReviewClassification[] = [
    "confirmed",
    "failed",
    "unknown",
  ];

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

<div class="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-workbench-review>
  <div class="mb-2 font-semibold text-amber-300">{t(k("workbench.review.title"))}</div>
  <p class="mb-2 opacity-80">{t(k("workbench.review.explanation"))}</p>

  {#if wbState.journalError}
    <div class="mb-2 rounded bg-red-500/10 p-2 text-red-300">
      <div>{t(k("workbench.review.journalError"))}</div>
      <div class="text-xs opacity-80">{wbState.journalError}</div>
      <button
        type="button"
        class="mt-1 rounded bg-red-500/30 px-2 py-0.5"
        onclick={onResetCorruptJournal}
      >
        {t(k("workbench.review.resetJournal"))}
      </button>
    </div>
  {/if}

  {#if wbState.unsettledCount > 0}
    <button
      type="button"
      class="rounded bg-white/10 px-2 py-0.5"
      disabled={busy}
      onclick={onReconcile}
    >
      {t(k("workbench.review.reconcile"))}
    </button>
  {/if}

  {#if report}
    {#if report.fetchError}
      <div class="mt-2 text-red-300">
        {t(k("workbench.review.fetchError"))}: {report.fetchError}
      </div>
    {/if}
    <div class="mt-2 space-y-1">
      {#each report.rows as row (row.intentId)}
        <div class="flex items-center gap-2 border-b border-white/10 py-1">
          <span class="min-w-0 flex-1 truncate">
            {row.itemName} · {row.quantity}x @ {row.platinum}p ({row.mode})
          </span>
          <span
            class="rounded px-1 text-xs {row.classification === 'confirmed'
              ? 'bg-emerald-500/20 text-emerald-300'
              : row.classification === 'failed'
                ? 'bg-red-500/20 text-red-300'
                : 'bg-amber-500/20 text-amber-300'}"
          >
            {t(k(`workbench.review.class.${row.classification}`))}
          </span>
          <select
            class="rounded bg-black/20 px-1 text-xs"
            value={pickFor(row.intentId, row.classification)}
            onchange={(event) => {
              picks[row.intentId] = (event.currentTarget as HTMLSelectElement)
                .value as WorkbenchReviewClassification;
            }}
          >
            {#each CLASSIFICATIONS as classification (classification)}
              <option value={classification}>
                {classification === "unknown"
                  ? t(k("workbench.review.leaveOpen"))
                  : t(k(`workbench.review.class.${classification}`))}
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
        class="mt-2 rounded bg-amber-500/30 px-2 py-0.5"
        disabled={busy || report.fetchError != null || settlingCount === 0}
        data-workbench-resolve
        onclick={confirmAll}
      >
        {t(k("workbench.review.confirmResolutions"))}
      </button>
    {/if}
  {/if}
</div>
