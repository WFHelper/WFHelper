<script lang="ts">
  import { onMount } from "svelte";

  import { DAY_MS } from "../lib/format.js";
  import { invoke, send } from "../lib/ipc.js";
  import { locale, tr, type MessageKey } from "../lib/i18n.js";
  import { useInterval } from "../lib/timers.js";
  import { APP_LOGO_URL } from "../lib/assetUrls.js";
  import { themeSettings } from "../stores/theme.js";
  import { DEFAULT_APP_NAME } from "../config/themeDefaults.js";
  import type { HelperStatus } from "../types/ipc.js";

  const HELPER_STATUS_POLL_MS = 5_000;
  const INVENTORY_OLD_MS = 60 * 60 * 1000;

  $: logoUrl = $themeSettings.branding.logoDataUrl;
  $: appName = $themeSettings.branding.appName || DEFAULT_APP_NAME;

  let helperStatus: HelperStatus | null = null;

  // Show just the clock time, plus the date once the data is over a day old.
  function formatHelperTime(ms: number | null, localeCode: string): string {
    if (!ms) return "";
    const d = new Date(ms);
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (Date.now() - ms > DAY_MS) {
      return `${d.toLocaleDateString(localeCode, { month: "short", day: "numeric" })}, ${time}`;
    }
    return time;
  }

  $: helperInventoryIsOld =
    Boolean(helperStatus?.inventoryLastModified) &&
    Date.now() - Number(helperStatus?.inventoryLastModified) > INVENTORY_OLD_MS;

  function helperStatusMessage(
    status: HelperStatus | null,
    isOld: boolean,
    localeCode: string,
  ): { key: MessageKey; params?: Record<string, string | number> } {
    if (!status) return { key: "titlebar.status.unknown" };
    if (status.running) return { key: "titlebar.status.refreshing" };
    if (status.inventoryLastModified) {
      const time = formatHelperTime(status.inventoryLastModified, localeCode);
      return { key: isOld ? "titlebar.status.old" : "titlebar.status.ok", params: { time } };
    }
    if (!status.exeFound) return { key: "titlebar.status.helperNotFound" };
    if (status.lastRunReason === "access-denied") return { key: "titlebar.status.accessDenied" };
    if (status.lastRunReason === "not-logged-in") return { key: "titlebar.status.waitingLogin" };
    if (status.lastRunReason === "token-not-found") return { key: "titlebar.status.tokenNotFound" };
    if (status.lastRunReason === "game-not-running") {
      return { key: "titlebar.status.gameNotRunning" };
    }
    return { key: "titlebar.status.dataMissing" };
  }

  function helperTooltipKey(status: HelperStatus | null): MessageKey {
    if (!status?.exeFound) return "titlebar.tooltip.helperNotFound";
    if (status.lastRunReason === "access-denied") return "titlebar.tooltip.accessDenied";
    if (status.lastRunReason === "not-logged-in") return "titlebar.tooltip.notLoggedIn";
    if (status.lastRunReason === "token-not-found") return "titlebar.tooltip.tokenNotFound";
    if (status.lastRunReason === "game-not-running") return "titlebar.tooltip.gameNotRunning";
    return "titlebar.tooltip.active";
  }

  function computeHelperDotClass(status: HelperStatus | null, isOld: boolean): string {
    if (!status) return "bg-text-muted";
    if (status.running) return "bg-warning";
    if (status.inventoryLastModified) return isOld ? "bg-warning-dim" : "bg-success";
    return "bg-danger";
  }

  $: statusMessage = helperStatusMessage(helperStatus, helperInventoryIsOld, $locale);
  $: helperStatusText = $tr(statusMessage.key, statusMessage.params);
  $: helperTooltipText = $tr(helperTooltipKey(helperStatus));
  $: helperDotClass = computeHelperDotClass(helperStatus, helperInventoryIsOld);
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

<header
  class="z-50 flex h-[var(--titlebar-height)] select-none items-center justify-between border-b border-border bg-bg-deep app-region-drag"
>
  <div class="flex min-w-0 items-center gap-2 pl-3.5">
    <img
      src={logoUrl || APP_LOGO_URL}
      alt={$tr("titlebar.logoAlt")}
      class="h-4 w-4 object-contain"
    />
    <span class="shrink-0 font-display text-xs font-semibold tracking-wide text-text-secondary">
      {appName}
    </span>
    <span
      class="inline-flex min-w-0 items-center gap-1 rounded border border-border-subtle bg-surface-hover px-2 py-0.5 text-[10px] text-text-muted"
      title={helperTooltipText}
    >
      <span
        class="inline-block h-1.5 w-1.5 rounded-full {helperDotClass} {helperDotPulse
          ? 'animate-pulse'
          : ''}"
      ></span>
      <span class="overflow-hidden text-ellipsis whitespace-nowrap max-w-48"
        >{helperStatusText}</span
      >
    </span>
  </div>
  <div class="app-region-no-drag flex">
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-secondary transition-[color,background-color] duration-150 hover:bg-bg-hover hover:text-text-primary"
      title={$tr("titlebar.minimize")}
      on:click={() => send("window-minimize")}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"
        ><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2" /></svg
      >
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-secondary transition-[color,background-color] duration-150 hover:bg-bg-hover hover:text-text-primary"
      title={$tr("titlebar.maximize")}
      on:click={() => send("window-maximize")}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12"
        ><rect
          x="2"
          y="2"
          width="8"
          height="8"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
        /></svg
      >
    </button>
    <button
      class="flex h-[var(--titlebar-height)] w-[var(--size-titlebar-control)] cursor-pointer items-center justify-center border-0 bg-transparent text-text-secondary transition-[color,background-color] duration-150 hover:bg-danger hover:text-text-primary"
      title={$tr("common.close")}
      on:click={() => send("window-close")}
    >
      <svg class="h-3 w-3" viewBox="0 0 12 12">
        <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.2" />
        <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
  </div>
</header>
