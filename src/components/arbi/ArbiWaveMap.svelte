<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";

  export let stats: ArbiRunStats;

  /** Above this per-wave clear time the box is flagged slow (reference threshold). */
  const SLOW_WAVE_SEC = 25;

  $: waves = stats.waves ?? [];
</script>

{#if waves.length > 0}
  <ThemedPanel className="flex flex-col p-5">
    <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">{$tr("arbi.waveMap.title")}</h3>
    <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.waveMap.desc")}</p>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5">
      {#each waves as wave (wave.index)}
        <div
          class="flex h-9 items-center justify-center rounded-sm border text-xs font-bold {wave.durationSec > SLOW_WAVE_SEC
            ? 'border-danger/50 bg-danger/15 text-danger'
            : 'border-success/50 bg-success/15 text-success'}"
          title="{wave.index}: {wave.durationSec.toFixed(1)}s"
        >
          {wave.index}
        </div>
      {/each}
    </div>
  </ThemedPanel>
{/if}
