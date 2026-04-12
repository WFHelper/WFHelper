<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { statusText, debugMode } from "../stores/app.js";
  import { appUpdateState } from "../stores/updates.js";
  import { addToast } from "../stores/toasts.js";
  import { ipc } from "../lib/ipc.js";
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
        const result = await ipc.installDownloadedUpdate();
        if (!result.ok) {
          addToast({
            level: "warning",
            title: "Update Install",
            message: result.message || "No downloaded update is ready.",
          });
        }
        return;
      }

      const result = await ipc.checkForAppUpdates();
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

<footer class="statusbar">
  <span class="statusbar-left">
    <span>{$statusText}</span>
    {#if $debugMode}
      <span class="debug-panel">
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
        class="debug-reset-btn"
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
    class="update-btn"
    title={$appUpdateState.message || "Check for app updates"}
    on:click={onUpdateAction}
    disabled={updateButtonDisabled}
  >
    {updateButtonText}
  </button>
  <span class="version-label" title="App version">v{import.meta.env.VITE_APP_VERSION || '?'}</span>
  <button
    class="debug-toggle"
    class:debug-active={debugActive}
    title="Toggle debug logging"
    on:click={() => debugMode.update(v => !v)}
  >
    Debug: {$debugMode ? 'ON' : 'OFF'}
  </button>
</footer>

<style>
  .statusbar {
    display: flex;
    height: var(--statusbar-height);
    user-select: none;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid var(--border);
    background: var(--bg-deep);
    padding: 0 0.875rem;
    font-size: 12px;
    color: var(--text-muted);
  }
  .statusbar-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .debug-panel {
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.2);
    background: rgba(255,255,255,0.05);
    padding: 0.125rem 0.5rem;
    font-family: monospace;
    font-size: 11px;
    color: var(--text-secondary);
  }
  .debug-reset-btn {
    cursor: pointer;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.2);
    background: rgba(255,255,255,0.05);
    padding: 0.125rem 0.375rem;
    font-size: 10px;
    color: var(--text-muted);
    transition: color 0.15s, border-color 0.15s;
  }
  .debug-reset-btn:hover {
    border-color: rgba(255,255,255,0.3);
    color: var(--text-primary);
  }
  .update-btn {
    margin-left: auto;
    margin-right: 0.5rem;
    cursor: pointer;
    border-radius: 9999px;
    border: 1px solid rgba(255,255,255,0.2);
    background: rgba(255,255,255,0.05);
    padding: 0.125rem 0.625rem;
    font-family: var(--font-body);
    font-size: 0.75rem;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    transition: color 0.15s, border-color 0.15s;
  }
  .update-btn:hover {
    border-color: rgba(255,255,255,0.3);
    color: var(--text-primary);
  }
  .update-btn:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .version-label {
    font-size: 10px;
    opacity: 0.5;
  }
  .debug-toggle {
    margin-right: 0.625rem;
    cursor: pointer;
    border-radius: 9999px;
    padding: 0.125rem 0.625rem;
    font-family: var(--font-body);
    font-size: 0.75rem;
    letter-spacing: 0.05em;
    border: 1px solid rgba(255,255,255,0.2);
    background: rgba(255,255,255,0.05);
    color: var(--text-muted);
    transition: color 0.15s, border-color 0.15s;
  }
  .debug-toggle:hover {
    border-color: rgba(255,255,255,0.3);
    color: var(--text-primary);
  }
  .debug-toggle.debug-active {
    border-color: rgba(110,231,183,0.5);
    background: rgba(16,185,129,0.15);
    color: #6ee7b7;
  }
</style>
