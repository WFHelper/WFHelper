<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import { dronesPerRotation, relativePerformanceHue } from "../../lib/arbi/arbiChartData.js";

  export let stats: ArbiRunStats;

  $: counts = dronesPerRotation(stats);
  $: minVal = counts.length ? Math.min(...counts) : 0;
  $: maxVal = counts.length ? Math.max(...counts) : 0;
  $: avgVal = counts.length ? counts.reduce((sum, c) => sum + c, 0) / counts.length : 0;

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
  {:else}
    <div
      class="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5"
      data-arbi-rotation-grid
    >
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
    <p class="mt-3 text-xs text-text-muted">
      {$tr("arbi.rotations.summary", {
        low: String(minVal),
        avg: avgVal.toFixed(1),
        high: String(maxVal),
      })}
    </p>
  {/if}
</ThemedPanel>
