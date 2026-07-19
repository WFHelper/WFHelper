<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import { dronesPerRotation, relativePerformanceHue } from "../../lib/arbi/arbiChartData.js";

  export let stats: ArbiRunStats;

  $: counts = dronesPerRotation(stats);
  $: minVal = counts.length ? Math.min(...counts) : 0;
  $: maxVal = counts.length ? Math.max(...counts) : 0;

  function color(count: number): string {
    if (count === maxVal) return "#00ff22";
    return `hsl(${relativePerformanceHue(count, minVal, maxVal)}, 100%, 50%)`;
  }
</script>

<ThemedPanel className="flex flex-col p-5">
  <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
    {$tr("arbi.rotations.title")}
  </h3>
  <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.rotations.desc")}</p>

  {#if counts.length === 0}
    <p class="py-4 text-center text-sm text-text-muted">–</p>
  {:else if counts.length <= 10}
    <ul class="m-0 flex list-none flex-col p-0">
      {#each counts as count, i (i)}
        <li class="flex items-center justify-between border-b border-border/40 px-1 py-1.5 text-sm">
          <span class="text-text-secondary"
            >{$tr("arbi.rotations.round", { n: String(i + 1) })}</span
          >
          <span class="font-bold" style="color:{color(count)}">{count}</span>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5">
      {#each counts as count, i (i)}
        <div
          class="flex h-9 items-center justify-center rounded-sm bg-bg-raised text-xs font-bold"
          style="color:{color(count)}"
          title={$tr("arbi.rotations.round", { n: String(i + 1) })}
        >
          {count}
        </div>
      {/each}
    </div>
  {/if}
</ThemedPanel>
