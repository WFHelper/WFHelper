<script lang="ts">
  // Aliased: a store named `tr` makes Svelte treat <tr> table rows as a component.
  import { tr as t } from "../../lib/i18n.js";
  import type { ArbiRunRecord } from "../../types/ipc.js";
  import { deleteArbiRun, deleteArbiRunLog } from "../../stores/arbiRuns.js";
  import {
    formatBytes,
    formatDuration,
    formatRunDate,
    missionKindLabel,
  } from "../../lib/arbi/arbiChartData.js";

  export let runs: ArbiRunRecord[] = [];
  export let onSelect: (id: string) => void;

  function typeBadgeClass(run: ArbiRunRecord): string {
    if (run.missionType === "defense") return "text-warning border-warning/40";
    if (run.missionType === "interception") return "text-accent border-accent/40";
    return "text-text-muted border-border";
  }

  function typeLabel(run: ArbiRunRecord): string {
    if (run.missionType === "defense") return $t("arbi.type.defense");
    if (run.missionType === "interception") return $t("arbi.type.interception");
    return missionKindLabel(run) ?? $t("arbi.type.other");
  }

  async function onDeleteRun(e: MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    if (!confirm($t("arbi.confirmDeleteRun"))) return;
    await deleteArbiRun(id);
  }

  async function onDeleteLog(e: MouseEvent, id: string): Promise<void> {
    e.stopPropagation();
    await deleteArbiRunLog(id);
  }
</script>

<div class="overflow-x-auto">
  <table class="w-full border-collapse text-sm">
    <thead>
      <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
        <th class="px-3 py-2 font-semibold">{$t("arbi.col.date")}</th>
        <th class="px-3 py-2 font-semibold">{$t("arbi.col.node")}</th>
        <th class="px-3 py-2 font-semibold">{$t("arbi.col.type")}</th>
        <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.duration")}</th>
        <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.rotations")}</th>
        <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.drones")}</th>
        <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.vitus")}</th>
        <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.log")}</th>
        <th class="px-3 py-2"></th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.id)}
        <tr
          class="cursor-pointer border-b border-border/50 transition-colors duration-100 hover:bg-bg-raised"
          on:click={() => onSelect(run.id)}
        >
          <td class="whitespace-nowrap px-3 py-2 text-text-secondary"
            >{formatRunDate(run.startedAt)}</td
          >
          <td class="px-3 py-2 font-semibold text-text-primary">
            {run.node}
            {#if run.source === "imported"}
              <span
                class="ml-1.5 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
                >{$t("arbi.source.imported")}</span
              >
            {/if}
          </td>
          <td class="px-3 py-2">
            <span
              class="rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide {typeBadgeClass(
                run,
              )}"
            >
              {typeLabel(run)}
            </span>
          </td>
          <td class="whitespace-nowrap px-3 py-2 text-right text-text-secondary"
            >{formatDuration(run.durationSec)}</td
          >
          <td class="px-3 py-2 text-right text-text-secondary">{run.rotations}</td>
          <td class="px-3 py-2 text-right text-text-secondary">{run.drones.toLocaleString()}</td>
          <td
            class="px-3 py-2 text-right {run.vitusActual !== null
              ? 'font-semibold text-accent'
              : 'text-text-muted'}"
          >
            {run.vitusActual !== null ? run.vitusActual.toLocaleString() : "–"}
          </td>
          <td class="whitespace-nowrap px-3 py-2 text-right text-text-muted">
            {run.logFile ? formatBytes(run.logSizeBytes) : "–"}
          </td>
          <td class="whitespace-nowrap px-3 py-2 text-right">
            {#if run.logFile}
              <button
                class="cursor-pointer rounded border border-transparent bg-transparent px-1.5 py-0.5 text-warning/60 transition-colors duration-100 hover:border-warning/40 hover:bg-warning/10 hover:text-warning"
                title={$t("arbi.deleteLog")}
                on:click={(e) => onDeleteLog(e, run.id)}
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
              on:click={(e) => onDeleteRun(e, run.id)}
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
