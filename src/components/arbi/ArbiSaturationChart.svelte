<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import {
    saturationAboveThresholdPct,
    saturationHue,
    thresholdHue,
  } from "../../lib/arbi/arbiChartData.js";

  export let stats: ArbiRunStats;

  const THRESHOLD = 15;

  $: buckets = stats.saturationBuckets;
  $: hasData = buckets.some((b) => b.seconds > 0);
  $: abovePct = saturationAboveThresholdPct(buckets, THRESHOLD);
</script>

<ThemedPanel className="flex flex-col p-5">
  <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
    {$tr("arbi.saturation.title")}
  </h3>
  <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.saturation.desc")}</p>

  {#if hasData}
    <div class="flex flex-col gap-1.5">
      {#each buckets as bucket, i (bucket.label)}
        <div class="flex items-center gap-2">
          <span class="w-12 shrink-0 text-right font-mono text-xs text-text-secondary"
            >{bucket.label}</span
          >
          <div class="h-3.5 flex-1 overflow-hidden rounded-sm bg-bg-raised">
            <div
              class="h-full rounded-sm"
              style="width:{Math.min(100, bucket.pct)}%; background-color: hsl({saturationHue(
                i,
              )}, 100%, 50%)"
            ></div>
          </div>
          <span class="w-12 shrink-0 text-right font-mono text-xs font-semibold text-text-primary"
            >{bucket.pct.toFixed(1)}%</span
          >
        </div>
      {/each}
    </div>

    <div class="mt-4 rounded-[var(--radius-md)] border border-border bg-bg-raised px-3 py-2.5">
      <div class="text-xs text-text-secondary">
        {$tr("arbi.saturation.threshold", { count: String(THRESHOLD) })}
      </div>
      <div
        class="mt-0.5 text-2xl font-bold"
        style="color: hsl({thresholdHue(abovePct)}, 100%, 50%)"
      >
        {abovePct.toFixed(1)}%
      </div>
    </div>
  {:else}
    <p class="py-4 text-center text-sm text-text-muted">–</p>
  {/if}
</ThemedPanel>
