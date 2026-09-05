<script lang="ts">
  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { tr as t } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunRecord } from "../../types/ipc.js";
  import {
    ARBI_SATURATION_THRESHOLD,
    formatRunDate,
    missionKindLabel,
  } from "../../lib/arbi/arbiChartData.js";
  import { ARBI_MISSION_TYPE_KEYS } from "../../lib/arbi/arbiLabels.js";
  import {
    arbiAveragePool,
    buildArbiComparison,
    formatArbiMetric,
  } from "../../lib/arbi/arbiCompare.js";
  import type { ArbiAverageScope } from "../../lib/arbi/arbiCompare.js";

  const {
    runs,
    filteredRuns,
    allRuns,
    onClose,
  }: {
    runs: ArbiRunRecord[];
    filteredRuns: ArbiRunRecord[];
    allRuns: ArbiRunRecord[];
    onClose: () => void;
  } = $props();

  let scope = $state<ArbiAverageScope>("filtered");

  const SCOPES: ArbiAverageScope[] = ["filtered", "missionType", "node", "squad"];

  const reference = $derived(runs[0] ?? null);
  // "Filtered" answers "how does this compare to what I am looking at"; the
  // narrower scopes answer "to every run like it", so they span the whole index.
  const pool = $derived(
    arbiAveragePool(scope === "filtered" ? filteredRuns : allRuns, reference, scope),
  );
  const rows = $derived(buildArbiComparison(runs, pool));
  const hasStatsGap = $derived(runs.some((run) => run.stats === null));

  const SCOPE_KEYS: Record<ArbiAverageScope, MessageKey> = {
    filtered: "arbi.compare.scope.filtered",
    missionType: "arbi.compare.scope.missionType",
    node: "arbi.compare.scope.node",
    squad: "arbi.compare.scope.squad",
  };

  function columnLabel(t: typeof $t, run: ArbiRunRecord): string {
    return missionKindLabel(run) ?? t(ARBI_MISSION_TYPE_KEYS[run.missionType]);
  }
</script>

<ThemedPanel className="flex flex-col p-4">
  <div class="mb-3 flex flex-wrap items-center gap-3">
    <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
      {$t("arbi.compare.title")}
    </h3>
    <label class="flex items-center gap-1.5 text-xs">
      <span class="uppercase tracking-wide text-text-muted">{$t("arbi.compare.average")}</span>
      <select
        class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
        bind:value={scope}
      >
        {#each SCOPES as option (option)}
          <option value={option}>{$t(SCOPE_KEYS[option])}</option>
        {/each}
      </select>
    </label>
    <span class="text-xs text-text-muted"
      >{$t("arbi.compare.poolSize", { count: String(pool.length) })}</span
    >
    <button
      type="button"
      class="ml-auto cursor-pointer rounded border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:border-accent hover:text-accent"
      onclick={onClose}>{$t("common.close")}</button
    >
  </div>

  <div class="overflow-x-auto">
    <table class="w-full border-collapse text-sm" data-arbi-compare-panel>
      <thead>
        <tr
          class="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted"
        >
          <th class="px-3 py-2 font-semibold">{$t("common.mission")}</th>
          {#each runs as run (run.id)}
            <th class="px-3 py-2 text-right font-semibold">
              <span class="block text-text-primary">{run.node}</span>
              <span class="block font-normal normal-case tracking-normal">
                {formatRunDate(run.startedAt)} · {columnLabel($t, run)}
              </span>
            </th>
          {/each}
          <th class="px-3 py-2 text-right font-semibold">{$t("arbi.compare.average")}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.metric.key)}
          <tr class="border-b border-border/40">
            <td class="px-3 py-1.5 text-text-secondary">
              {$t(row.metric.labelKey, { count: String(ARBI_SATURATION_THRESHOLD) })}
            </td>
            {#each row.cells as cell, i (runs[i].id)}
              {@const text = formatArbiMetric(cell.value, row.metric.format)}
              <td
                class="px-3 py-1.5 text-right {cell.best
                  ? 'font-bold text-success'
                  : text === null
                    ? 'text-text-muted'
                    : 'text-text-primary'}"
              >
                {text ?? $t("arbi.compare.na")}
              </td>
            {/each}
            <td class="px-3 py-1.5 text-right text-text-secondary">
              {formatArbiMetric(row.average, row.metric.format) ?? $t("arbi.compare.na")}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if hasStatsGap}
    <p class="mb-0 mt-3 text-xs text-text-muted">{$t("arbi.noStats")}</p>
  {/if}
</ThemedPanel>
