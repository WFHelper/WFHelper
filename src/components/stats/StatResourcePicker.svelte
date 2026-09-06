<script lang="ts">
  import ModalShell from "../ModalShell.svelte";
  import ThemedButton from "../ThemedButton.svelte";
  import { tr } from "../../lib/i18n.js";
  import { STAT_RESOURCES } from "../../../config/shared/statsTypes.js";
  import {
    chartResources,
    resetChartResources,
    statResourceLabelKey,
    toggleChartResource,
  } from "../../stores/statsDisplay.js";

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  const resources = STAT_RESOURCES.map((resource) => ({
    id: resource.id,
    labelKey: statResourceLabelKey(resource.id),
  }));

  const selected = $derived(new Set($chartResources));
</script>

<ModalShell ariaLabel={$tr("stats.chartResources")} {onClose}>
  <div
    class="relative z-10 flex max-h-[80vh] w-[min(46rem,90vw)] flex-col gap-3 overflow-hidden rounded-[var(--radius-xl)] border border-border-strong bg-bg-surface p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
  >
    <div class="flex shrink-0 items-center justify-between gap-3">
      <div class="flex flex-col gap-1">
        <span class="text-sm font-semibold uppercase tracking-wide text-text-muted">
          {$tr("stats.chartResources")}
        </span>
        <span class="text-xs text-text-muted">{$tr("stats.chartResourcesHint")}</span>
      </div>
      <div class="flex items-center gap-2">
        <ThemedButton onClick={() => chartResources.set(STAT_RESOURCES.map((r) => r.id))}>
          {$tr("common.selectAll")}
        </ThemedButton>
        <ThemedButton onClick={resetChartResources}>{$tr("common.reset")}</ThemedButton>
        <ThemedButton onClick={onClose}>{$tr("common.close")}</ThemedButton>
      </div>
    </div>

    <div
      class="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2 overflow-y-auto"
    >
      {#each resources as resource (resource.id)}
        <label
          class="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] bg-bg-raised px-2.5 py-1.5 text-xs text-text-secondary transition-[color,border-color] duration-150 hover:border-accent hover:text-accent"
        >
          <input
            type="checkbox"
            checked={selected.has(resource.id)}
            data-stat-resource={resource.id}
            onchange={() => toggleChartResource(resource.id)}
          />
          <span class="truncate">{$tr(resource.labelKey)}</span>
        </label>
      {/each}
    </div>
  </div>
</ModalShell>
