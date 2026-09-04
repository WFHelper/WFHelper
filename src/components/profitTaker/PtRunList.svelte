<script lang="ts">
  // Aliased: a store named `tr` makes Svelte treat <tr> table rows as a component.
  import { tr as t } from "../../lib/i18n.js";
  import type { PtRunRecord } from "../../types/ipc.js";
  import { deletePtRun, deletePtRunLog } from "../../stores/ptRuns.js";
  import { confirmWithDialog } from "../../lib/ipc.js";
  import { formatBytes, formatRunDate } from "../../lib/arbi/arbiChartData.js";
  import { formatPtTime } from "../../lib/profitTakerStats.js";

  interface Props {
    runs: PtRunRecord[];
    onSelect: (id: string) => void;
    /** Fastest clean run; gets the PB badge. */
    bestRunId?: string | null;
  }

  const { runs, onSelect, bestRunId = null }: Props = $props();

  async function onDeleteRun(e: MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    if (!(await confirmWithDialog($t("arbi.confirmDeleteRun"), $t))) return;
    await deletePtRun(id);
  }

  async function onDeleteLog(e: MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    await deletePtRunLog(id);
  }
</script>

<div class="overflow-x-auto" data-pt-runs>
  <table class="w-full border-collapse text-sm">
    <thead>
      <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
        <th class="px-3 py-2 font-semibold">{$t("arbi.col.date")}</th>
        <th class="px-3 py-2 text-right font-semibold">{$t("common.total")}</th>
        <th class="px-3 py-2 text-right font-semibold">{$t("pt.stat.flight")}</th>
        <th class="px-3 py-2"></th>
        <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.log")}</th>
        <th class="px-3 py-2"></th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.id)}
        <tr
          data-pt-run={run.id}
          class="cursor-pointer border-b border-border/50 transition-colors duration-100 hover:bg-bg-raised"
          onclick={() => onSelect(run.id)}
        >
          <td class="whitespace-nowrap px-3 py-2 text-text-secondary"
            >{formatRunDate(run.startedAt)}</td
          >
          <td
            class="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold text-text-primary"
            >{formatPtTime(run.durationSec)}</td
          >
          <td class="whitespace-nowrap px-3 py-2 text-right font-mono text-text-secondary"
            >{formatPtTime(run.flightSec)}</td
          >
          <td class="px-3 py-2">
            <span class="flex flex-wrap items-center gap-1">
              <span
                class="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
                >{run.solo ? $t("relics.squad.solo") : $t("relics.squadLabel")}</span
              >
              {#if run.aborted}
                <span
                  class="rounded border border-danger/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-danger"
                  >{$t("arbi.end.aborted")}</span
                >
              {:else if run.complete}
                <span
                  class="rounded border border-success/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success"
                  >{$t("pt.badge.complete")}</span
                >
              {:else}
                <span
                  class="rounded border border-warning/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
                  title={$t("arbi.incompleteHint")}>{$t("arbi.incomplete")}</span
                >
              {/if}
              {#if run.bugged}
                <span
                  data-pt-bugged
                  class="rounded border border-warning/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
                  title={$t("pt.badge.buggedHint")}>{$t("pt.badge.bugged")}</span
                >
              {/if}
              {#if run.id === bestRunId}
                <span
                  data-pt-pb
                  class="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success"
                  >{$t("arbi.pb.badge")}</span
                >
              {/if}
              {#if run.source === "imported"}
                <span
                  class="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
                  >{$t("common.imported")}</span
                >
              {/if}
              {#if run.duplicateOf}
                <span
                  data-pt-duplicate
                  class="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
                  title={$t("arbi.duplicateHint")}>{$t("arbi.duplicate")}</span
                >
              {/if}
              {#each run.tags ?? [] as tag (tag)}
                <span
                  class="rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-info"
                  >{tag}</span
                >
              {/each}
            </span>
          </td>
          <td class="whitespace-nowrap px-3 py-2 text-right text-text-muted">
            {run.logFile ? formatBytes(run.logSizeBytes) : "–"}
          </td>
          <td class="whitespace-nowrap px-3 py-2 text-right">
            {#if run.logFile}
              <button
                class="cursor-pointer rounded border border-transparent bg-transparent px-1.5 py-0.5 text-warning/60 transition-colors duration-100 hover:border-warning/40 hover:bg-warning/10 hover:text-warning"
                title={$t("arbi.deleteLog")}
                onclick={(e) => onDeleteLog(e, run.id)}
              >
                <svg
                  class="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="m9.5 12.5 5 5" />
                  <path d="m14.5 12.5-5 5" />
                </svg>
              </button>
            {/if}
            <button
              class="cursor-pointer rounded border border-transparent bg-transparent px-1.5 py-0.5 text-danger/60 transition-colors duration-100 hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
              title={$t("arbi.deleteRun")}
              onclick={(e) => onDeleteRun(e, run.id)}
            >
              <svg
                class="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
