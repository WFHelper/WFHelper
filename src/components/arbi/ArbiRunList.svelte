<script lang="ts">
  // Aliased: a store named `tr` makes svelte-check flag every <tr> row as a lowercase component.
  import { tr as t } from "../../lib/i18n.js";
  import type { ArbiRunRecord } from "../../types/ipc.js";
  import { deleteArbiRun, deleteArbiRunLog } from "../../stores/arbiRuns.js";
  import { formatDuration, missionKindLabel } from "../../lib/arbi/arbiChartData.js";
  import { ARBI_MISSION_TYPE_KEYS } from "../../lib/arbi/arbiLabels.js";
  import { isIncompleteRun } from "../../lib/arbi/arbiCompare.js";
  import RunList from "./RunList.svelte";

  interface Props {
    runs?: ArbiRunRecord[];
    onSelect: (id: string) => void;
    selected?: Set<string>;
    onToggleSelect?: (id: string) => void;
    onToggleSelectAll?: () => void;
  }

  const {
    runs = [],
    onSelect,
    selected = new Set<string>(),
    onToggleSelect = () => {},
    onToggleSelectAll = () => {},
  }: Props = $props();

  function typeBadgeClass(run: ArbiRunRecord): string {
    if (run.missionType === "defense") return "text-warning border-warning/40";
    if (run.missionType === "interception") return "text-accent border-accent/40";
    if (run.missionType === "disruption") return "text-accent border-accent/40";
    return "text-text-muted border-border";
  }

  // Named mission kinds are game data; only the fallback words are translated.
  function typeLabel(t: typeof $t, run: ArbiRunRecord): string {
    return missionKindLabel(run) ?? t(ARBI_MISSION_TYPE_KEYS[run.missionType]);
  }
</script>

{#snippet headers()}
  <th class="px-3 py-2 font-semibold">{$t("common.node")}</th>
  <th class="px-3 py-2 font-semibold">{$t("common.type")}</th>
  <th class="px-3 py-2 text-right font-semibold">{$t("common.duration")}</th>
  <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.rotations")}</th>
  <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.drones")}</th>
  <th class="px-3 py-2 text-right font-semibold">{$t("arbi.col.vitus")}</th>
{/snippet}

{#snippet cells(run: ArbiRunRecord)}
  <td class="px-3 py-2 font-semibold text-text-primary">
    {run.node}
    {#if run.source === "imported"}
      <span
        class="ml-1.5 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
        >{$t("common.imported")}</span
      >
    {/if}
    {#if isIncompleteRun(run)}
      <span
        data-arbi-incomplete
        class="ml-1.5 rounded border border-warning/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
        title={$t("arbi.incompleteHint")}>{$t("arbi.incomplete")}</span
      >
    {/if}
    {#if run.duplicateOf}
      <span
        data-arbi-duplicate
        class="ml-1.5 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
        title={$t("arbi.duplicateHint")}>{$t("arbi.duplicate")}</span
      >
    {/if}
    {#if run.tags && run.tags.length > 0}
      <span class="mt-1 flex flex-wrap gap-1">
        {#each run.tags as tag (tag)}
          <span
            class="rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-info"
            >{tag}</span
          >
        {/each}
      </span>
    {/if}
  </td>
  <td class="px-3 py-2">
    <span
      class="rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide {typeBadgeClass(
        run,
      )}"
    >
      {typeLabel($t, run)}
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
{/snippet}

<RunList
  {runs}
  {onSelect}
  {headers}
  {cells}
  {selected}
  {onToggleSelect}
  {onToggleSelectAll}
  deleteRun={deleteArbiRun}
  deleteRunLog={deleteArbiRunLog}
/>
