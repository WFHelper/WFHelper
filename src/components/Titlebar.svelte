<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { invoke, send } from "../lib/ipc.js";
  import { themeSettings } from "../stores/theme.js";
  import { DEFAULT_APP_NAME } from "../config/themeDefaults.js";
  import type { HelperStatus } from "../types/ipc.js";

  const HELPER_STATUS_POLL_MS = 5_000;

  $: logoUrl = $themeSettings.branding.logoDataUrl;
  $: appName = $themeSettings.branding.appName || DEFAULT_APP_NAME;

  let helperStatus: HelperStatus | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function formatHelperTime(ms: number | null): string {
    if (!ms) return "";
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  $: helperStatusText = (() => {
    if (!helperStatus) return "WF data unknown";
    if (helperStatus.running) return "WF data refreshing...";
    if (helperStatus.inventoryLastModified) {
      return `WF data OK - ${formatHelperTime(helperStatus.inventoryLastModified)}`;
    }
    if (!helperStatus.exeFound) return "WF helper not found";
    return "WF data missing";
  })();

  $: helperDotColor = (() => {
    if (!helperStatus) return "#6b7280";
    if (helperStatus.running) return "#facc15";
    if (helperStatus.inventoryLastModified) return "#34d399";
    return "#f87171";
  })();
  $: helperDotPulse = helperStatus?.running ?? false;

  onMount(() => {
    const refreshHelperStatus = (): void => {
      invoke("getHelperStatus")
        .then((status) => {
          helperStatus = status;
        })
        .catch(() => {});
    };

    refreshHelperStatus();
    pollTimer = setInterval(refreshHelperStatus, HELPER_STATUS_POLL_MS);
  });

  onDestroy(() => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
</script>

<header class="titlebar app-region-drag">
  <div class="titlebar-left">
    <img src={logoUrl || "logo.png"} alt="Logo" class="titlebar-logo" />
    <span class="titlebar-name">
      {appName}
    </span>
    <span
      class="titlebar-helper"
      title={helperStatus?.exeFound ? "warframe-api-helper active" : "warframe-api-helper not found"}
    >
      <span class="helper-dot" class:helper-dot--pulse={helperDotPulse} style="background:{helperDotColor}"></span>
      <span class="helper-text">{helperStatusText}</span>
    </span>
  </div>
  <div class="app-region-no-drag titlebar-controls">
    <button
      class="titlebar-btn"
      title="Minimize"
      on:click={() => send("window-minimize")}
    >
      <svg class="titlebar-icon" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="titlebar-btn"
      title="Maximize"
      on:click={() => send("window-maximize")}
    >
      <svg class="titlebar-icon" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="titlebar-btn titlebar-btn--close"
      title="Close"
      on:click={() => send("window-close")}
    >
      <svg class="titlebar-icon" viewBox="0 0 12 12">
        <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/>
        <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.2"/>
      </svg>
    </button>
  </div>
</header>

<style>
  .titlebar {
    z-index: 50;
    display: flex;
    height: var(--titlebar-height);
    user-select: none;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    background: var(--bg-deep);
  }
  .titlebar-left {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    padding-left: 0.875rem;
  }
  .titlebar-logo {
    height: 1rem;
    width: 1rem;
    object-fit: contain;
  }
  .titlebar-name {
    font-family: var(--font-display);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .titlebar-helper {
    display: none;
    align-items: center;
    gap: 0.25rem;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.05);
    padding: 0.125rem 0.5rem;
    font-size: 10px;
    color: var(--text-muted);
  }
  @media (min-width: 1024px) {
    .titlebar-helper { display: inline-flex; }
  }
  .helper-dot {
    display: inline-block;
    height: 6px;
    width: 6px;
    border-radius: 50%;
  }
  .helper-dot--pulse {
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .helper-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 18rem;
  }
  .titlebar-controls {
    display: flex;
  }
  .titlebar-btn {
    display: flex;
    height: var(--titlebar-height);
    width: var(--size-titlebar-control);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    transition: color 0.15s, background-color 0.15s;
  }
  .titlebar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .titlebar-btn--close:hover {
    background: var(--danger);
    color: white;
  }
  .titlebar-icon {
    height: 0.75rem;
    width: 0.75rem;
  }
</style>
