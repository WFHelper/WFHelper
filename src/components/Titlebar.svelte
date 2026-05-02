<script lang="ts">
  import { onMount } from "svelte";

  import { invoke, send } from "../lib/ipc.js";
  import { useInterval } from "../lib/timers.js";
  import { themeSettings } from "../stores/theme.js";
  import { DEFAULT_APP_NAME } from "../config/themeDefaults.js";
  import type { HelperStatus } from "../types/ipc.js";

  const HELPER_STATUS_POLL_MS = 5_000;

  $: logoUrl = $themeSettings.branding.logoDataUrl;
  $: appName = $themeSettings.branding.appName || DEFAULT_APP_NAME;

  let helperStatus: HelperStatus | null = null;

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

    return useInterval(refreshHelperStatus, HELPER_STATUS_POLL_MS, { immediate: true });
  });
</script>

<header class="z-50 flex h-[var(--titlebar-height)] select-none items-center justify-between border-b border-border bg-bg-deep app-region-drag">
  <div class="flex min-w-0 items-center gap-2 pl-[0.875rem]">
    <img src={logoUrl || "logo.png"} alt="Logo" class="h-4 w-4 object-contain" />
    <span class="font-display text-xs font-semibold tracking-wide text-text-secondary">
      {appName}
    </span>
    <span
      class="hidden lg:inline-flex items-center gap-1 rounded border border-[rgba(255,255,255,0.15)] bg-[rgba(255,255,255,0.05)] px-2 py-0.5 text-[10px] text-text-muted"
      title={helperStatus?.exeFound ? "warframe-api-helper active" : "warframe-api-helper not found"}
    >
      <span class="inline-block h-1.5 w-1.5 rounded-full {helperDotPulse ? 'animate-pulse' : ''}" style="background:{helperDotColor}"></span>
      <span class="overflow-hidden text-ellipsis whitespace-nowrap max-w-[18rem]">{helperStatusText}</span>
    </span>
  </div>
  <div class="app-region-no-drag flex">
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-secondary transition-[color,background-color] duration-150 hover:bg-bg-hover hover:text-text-primary"
      title="Minimize"
      on:click={() => send("window-minimize")}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-secondary transition-[color,background-color] duration-150 hover:bg-bg-hover hover:text-text-primary"
      title="Maximize"
      on:click={() => send("window-maximize")}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-secondary transition-[color,background-color] duration-150 hover:bg-danger hover:text-white"
      title="Close"
      on:click={() => send("window-close")}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12">
        <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/>
        <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.2"/>
      </svg>
    </button>
  </div>
</header>

