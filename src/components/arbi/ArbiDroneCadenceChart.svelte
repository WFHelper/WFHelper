<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import { formatClock, bucketSuccessMixPct } from "../../lib/arbi/arbiChartData.js";
  import { hasCadenceData } from "../../lib/arbi/arbiCadence.js";
  import {
    ARBI_DRY_WAIT_SEC,
    ARBI_PEAK_WINDOW_SEC,
    computeDroneCadence,
  } from "../../lib/arbi/arbiDroneCadence.js";

  const { stats }: { stats: ArbiRunStats } = $props();

  // Without the pause windows every reward screen would read as a dry spell.
  const cadence = $derived(hasCadenceData(stats) ? computeDroneCadence(stats) : null);
</script>

{#if cadence && cadence.totalWaitSec > 0}
  <ThemedPanel className="flex flex-col p-5">
    <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
      {$tr("arbi.droneCadence.title")}
    </h3>
    <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.droneCadence.desc")}</p>

    <div class="flex flex-col gap-1.5" data-arbi-drone-cadence>
      {#each cadence.buckets as bucket, i (bucket.label)}
        <div class="flex items-center gap-2">
          <span class="w-12 shrink-0 text-right font-mono text-xs text-text-secondary"
            >{bucket.label}</span
          >
          <div class="h-3.5 flex-1 overflow-hidden rounded-sm bg-bg-raised">
            <div
              class="h-full rounded-sm"
              style="width:{Math.min(
                100,
                bucket.pct,
              )}%; background-color: color-mix(in oklab, var(--success) {bucketSuccessMixPct(
                i,
              )}%, var(--danger))"
            ></div>
          </div>
          <span class="w-12 shrink-0 text-right font-mono text-xs font-semibold text-text-primary"
            >{bucket.pct.toFixed(1)}%</span
          >
        </div>
      {/each}
    </div>

    <div class="mt-4 grid grid-cols-2 gap-3">
      <div class="rounded-[var(--radius-md)] border border-border bg-bg-raised px-3 py-2.5">
        <div class="text-xs text-text-secondary">
          {$tr("arbi.droneCadence.dry", { sec: String(ARBI_DRY_WAIT_SEC) })}
        </div>
        <div class="mt-0.5 text-2xl font-bold text-text-primary">
          {cadence.dryPct.toFixed(1)}%
        </div>
      </div>
      <div class="rounded-[var(--radius-md)] border border-border bg-bg-raised px-3 py-2.5">
        <div class="text-xs text-text-secondary">
          {$tr("arbi.droneCadence.peak", { sec: String(ARBI_PEAK_WINDOW_SEC) })}
        </div>
        <div class="mt-0.5 text-2xl font-bold text-text-primary">
          {cadence.peak ? cadence.peak.drones : "–"}
        </div>
        {#if cadence.peak}
          <span class="text-xs text-text-muted">
            {$tr("arbi.cadence.atTime", { time: formatClock(cadence.peak.atSec) })}
          </span>
        {/if}
      </div>
    </div>
  </ThemedPanel>
{/if}
