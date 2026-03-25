<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { ipc } from "../lib/ipc.js";
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

  $: helperDotClass = (() => {
    if (!helperStatus) return "bg-gray-500";
    if (helperStatus.running) return "bg-yellow-400 animate-pulse";
    if (helperStatus.inventoryLastModified) return "bg-emerald-400";
    return "bg-red-400";
  })();

  onMount(() => {
    const refreshHelperStatus = (): void => {
      ipc
        .getHelperStatus()
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

<header
  class="app-region-drag z-50 flex h-[var(--titlebar-height)] select-none items-center justify-between border-b border-[var(--border)] bg-[var(--bg-deep)]"
>
  <div class="flex min-w-0 items-center gap-2 pl-3.5">
    {#if logoUrl}
      <img src={logoUrl} alt="Logo" class="h-4 w-4 object-contain" />
    {:else}
      <svg class="h-4 w-4 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polygon points="12,2 22,20 2,20" />
        <circle cx="12" cy="14" r="3" />
      </svg>
    {/if}
    <span class="font-[var(--font-display)] text-xs font-semibold tracking-wider text-[var(--text-secondary)]">
      {appName}
    </span>
    <span
      class="hidden items-center gap-1 rounded border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] text-[var(--text-muted)] lg:inline-flex"
      title={helperStatus?.exeFound ? "warframe-api-helper active" : "warframe-api-helper not found"}
    >
      <span class="inline-block h-[6px] w-[6px] rounded-full {helperDotClass}"></span>
      <span class="truncate max-w-[18rem]">{helperStatusText}</span>
    </span>
  </div>
  <div class="app-region-no-drag flex">
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      title="Minimize"
      on:click={ipc.minimizeWindow}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      title="Maximize"
      on:click={ipc.maximizeWindow}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--danger)] hover:text-white"
      title="Close"
      on:click={ipc.closeWindow}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12">
        <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/>
        <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.2"/>
      </svg>
    </button>
  </div>
</header>
