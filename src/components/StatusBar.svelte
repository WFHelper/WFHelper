<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { statusText, debugMode } from "../stores/app.js";
  import { appUpdateState } from "../stores/updates.js";
  import { addToast } from "../stores/toasts.js";
  import { invoke } from "../lib/ipc.js";
  import { perfSnapshot, resetPerfMetrics } from "../lib/perf.js";
  import {
    getPriceDebugCounters,
    getPriceQueueStats,
    resetPriceDebugCounters,
    type PriceDebugCounters,
    type PriceQueueStats,
  } from "../lib/wfm/wfmPrice.js";
  import { getPriceCacheStats, type PriceCacheStats } from "../lib/wfm/priceCache.js";
  import {
    getRelicRuntimeCacheStats,
    type RelicRuntimeCacheStats,
  } from "../lib/relic.js";

  import { normalizeErrorMessage } from "../../config/shared/errors.js";

  const COUNTER_POLL_MS = 1000;

  let counters: PriceDebugCounters = getPriceDebugCounters();
  let queueStats: PriceQueueStats = getPriceQueueStats();
  let priceCacheStats: PriceCacheStats = getPriceCacheStats();
  let relicCacheStats: RelicRuntimeCacheStats = getRelicRuntimeCacheStats();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let updateActionPending = false;

  function msOrDash(value: number | null): string {
    return value == null ? "-" : `${value}`;
  }

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

  $: debugActive = $debugMode;

  $: updateButtonDisabled = updateActionPending || $appUpdateState.status === "checking";
  $: updateButtonText =
    $appUpdateState.status === "checking"
      ? "Checking..."
      : $appUpdateState.status === "downloading"
        ? `Downloading ${Math.round($appUpdateState.percent || 0)}%`
        : $appUpdateState.status === "downloaded"
          ? "Install update"
          : "Check updates";

  async function onUpdateAction(): Promise<void> {
    updateActionPending = true;
    try {
      if ($appUpdateState.status === "downloaded") {
        const result = await invoke("installDownloadedUpdate");
        if (!result.ok) {
          addToast({
            level: "warning",
            title: "Update Install",
            message: result.message || "No downloaded update is ready.",
          });
        }
        return;
      }

      const result = await invoke("checkForAppUpdates");
      if (!result.ok && result.message) {
        addToast({
          level: "warning",
          title: "Update Check",
          message: result.message,
        });
      } else if (result.state.status === "not-available") {
        addToast({
          level: "info",
          title: "Up To Date",
          message: "You already have the latest version.",
        });
      }
    } catch (err) {
      addToast({
        level: "error",
        title: "Update Error",
        message: normalizeErrorMessage(err),
      });
    } finally {
      updateActionPending = false;
    }
  }
</script>

<footer class="flex h-[var(--statusbar-height)] select-none items-center justify-between border-t border-border bg-bg-deep px-[0.875rem] text-[12px] text-text-muted">
  <span class="flex items-center gap-2">
    <span>{$statusText}</span>
    {#if $debugMode}
      <span class="rounded border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.05)] px-2 py-0.5 font-mono text-[11px] text-text-secondary">
        WFM r:{counters.requests}
        hit:{counters.cacheHitOk + counters.cacheHitNoData}
        ded:{counters.inFlightDeduped}
        h:{counters.httpCalls}
        ok:{counters.resultOk}
        nd:{counters.resultNoData}
        tr:{counters.resultTransient}
        429:{counters.rateLimited}
        q:{queueStats.high}/{queueStats.normal}/{queueStats.low}@{queueStats.delayMs}ms
        pc:{priceCacheStats.total}
        evc:{relicCacheStats.evEntries}
        rcc:{relicCacheStats.cardPriceEntries}
        p-start:{msOrDash($perfSnapshot.startupInteractiveMs)}
        p-open:{msOrDash($perfSnapshot.heavyViewOpenMs.world)}/{msOrDash($perfSnapshot.heavyViewOpenMs.market)}/{msOrDash($perfSnapshot.heavyViewOpenMs.relics)}
        p-relic:{msOrDash($perfSnapshot.relicWarmupFirstUsefulMs)}/{msOrDash($perfSnapshot.relicWarmupCompleteMs)}
      </span>
      <button
        class="cursor-pointer rounded border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 text-[10px] text-text-muted transition-[color,border-color] duration-150 hover:border-[rgba(255,255,255,0.3)] hover:text-text-primary"
        title="Reset debug counters"
        on:click={() => {
          resetPriceDebugCounters();
          resetPerfMetrics();
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
    class="ml-auto mr-2 cursor-pointer rounded-full border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.05)] px-[0.625rem] py-0.5 font-body text-xs tracking-wide text-text-muted transition-[color,border-color] duration-150 hover:border-[rgba(255,255,255,0.3)] hover:text-text-primary disabled:cursor-default disabled:opacity-60"
    title={$appUpdateState.message || "Check for app updates"}
    on:click={onUpdateAction}
    disabled={updateButtonDisabled}
  >
    {updateButtonText}
  </button>
  <span class="text-[10px] opacity-50" title="App version">v{import.meta.env.VITE_APP_VERSION || '?'}</span>
  <button
    class="debug-toggle mr-[0.625rem] cursor-pointer rounded-full px-[0.625rem] py-0.5 font-body text-xs tracking-wide border border-[rgba(255,255,255,0.2)] bg-[rgba(255,255,255,0.05)] text-text-muted transition-[color,border-color] duration-150 hover:border-[rgba(255,255,255,0.3)] hover:text-text-primary"
    class:debug-active={debugActive}
    title="Toggle debug logging"
    on:click={() => debugMode.update(v => !v)}
  >
    Debug: {$debugMode ? 'ON' : 'OFF'}
  </button>
</footer>

<style>
  .debug-toggle.debug-active {
    border-color: rgba(110,231,183,0.5);
    background: rgba(16,185,129,0.15);
    color: #6ee7b7;
  }
</style>
