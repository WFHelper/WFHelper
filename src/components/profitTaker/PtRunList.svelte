<script lang="ts">
  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { tr as t } from "../../lib/i18n.js";
  import type { PtRunRecord } from "../../types/ipc.js";
  import { deletePtRun, deletePtRunLog } from "../../stores/ptRuns.js";
  import { formatPtTime } from "../../lib/profitTakerStats.js";
  import RunList from "../arbi/RunList.svelte";

  interface Props {
    runs: PtRunRecord[];
    onSelect: (id: string) => void;
    /** Fastest clean run; gets the PB badge. */
    bestRunId?: string | null;
  }

  const { runs, onSelect, bestRunId = null }: Props = $props();
</script>

{#snippet headers()}
  <th class="px-3 py-2 text-right font-semibold">{$t("common.total")}</th>
  <th class="px-3 py-2 text-right font-semibold">{$t("pt.stat.flight")}</th>
  <th class="px-3 py-2"></th>
{/snippet}

{#snippet cells(run: PtRunRecord)}
  <td class="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold text-text-primary"
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
{/snippet}

<RunList
  {runs}
  {onSelect}
  {headers}
  {cells}
  deleteRun={deletePtRun}
  deleteRunLog={deletePtRunLog}
  listAttrs={{ "data-pt-runs": "" }}
  rowAttrs={(run) => ({ "data-pt-run": run.id })}
/>
