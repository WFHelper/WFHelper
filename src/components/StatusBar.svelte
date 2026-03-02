<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { statusText, debugMode } from "../stores/app.js";
  import {
    getPriceDebugCounters,
    getPriceQueueStats,
    resetPriceDebugCounters,
    type PriceDebugCounters,
    type PriceQueueStats,
  } from "../lib/wfmPrice.js";
  import { getPriceCacheStats, type PriceCacheStats } from "../lib/priceCache.js";
  import {
    getRelicRuntimeCacheStats,
    type RelicRuntimeCacheStats,
  } from "../lib/relic.js";

  const COUNTER_POLL_MS = 1000;

  let counters: PriceDebugCounters = getPriceDebugCounters();
  let queueStats: PriceQueueStats = getPriceQueueStats();
  let priceCacheStats: PriceCacheStats = getPriceCacheStats();
  let relicCacheStats: RelicRuntimeCacheStats = getRelicRuntimeCacheStats();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    pollTimer = setInterval(() => {
      counters = getPriceDebugCounters();
      queueStats = getPriceQueueStats();
      priceCacheStats = getPriceCacheStats();
      relicCacheStats = getRelicRuntimeCacheStats();
    }, COUNTER_POLL_MS);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  $: debugToggleClass = $debugMode
    ? "border border-emerald-300/50 bg-emerald-500/15 text-emerald-300"
    : "border border-white/20 bg-white/5 text-[var(--text-muted)] hover:border-white/30 hover:text-[var(--text-primary)]";
</script>

<footer class="flex h-[var(--statusbar-height)] select-none items-center justify-between border-t border-[var(--border)] bg-[var(--bg-deep)] px-3.5 text-[12px] text-[var(--text-muted)]">
  <span class="flex items-center gap-2">
    <span>{$statusText}</span>
    {#if $debugMode}
      <span class="rounded border border-white/20 bg-white/5 px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
        WFM r:{counters.requests}
        hit:{counters.cacheHitOk + counters.cacheHitNoData}
        h:{counters.httpCalls}
        ok:{counters.resultOk}
        nd:{counters.resultNoData}
        tr:{counters.resultTransient}
        429:{counters.rateLimited}
        q:{queueStats.high}/{queueStats.normal}/{queueStats.low}
        pc:{priceCacheStats.total}
        evc:{relicCacheStats.evEntries}
        rcc:{relicCacheStats.cardPriceEntries}
      </span>
      <button
        class="cursor-pointer rounded border border-white/20 bg-white/5 px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors duration-150 hover:border-white/30 hover:text-[var(--text-primary)]"
        title="Reset WFM debug counters"
        on:click={() => {
          resetPriceDebugCounters();
          counters = getPriceDebugCounters();
          queueStats = getPriceQueueStats();
          priceCacheStats = getPriceCacheStats();
          relicCacheStats = getRelicRuntimeCacheStats();
        }}
      >
        reset
      </button>
    {/if}
  </span>
  <button
    class={`ml-auto mr-2.5 cursor-pointer rounded-full px-2.5 py-0.5 font-[var(--font-body)] text-xs tracking-wide transition-colors duration-150 ${debugToggleClass}`}
    title="Toggle debug logging"
    on:click={() => debugMode.update(v => !v)}
  >
    Debug: {$debugMode ? 'ON' : 'OFF'}
  </button>
</footer>
