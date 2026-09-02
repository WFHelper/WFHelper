<script lang="ts">
  import { onMount } from "svelte";

  import type {
    MarketAlertEngineStatus,
    MarketAlertHit,
  } from "../../../config/shared/marketAlertTypes.js";
  import { tr, locale, type MessageKey } from "../../lib/i18n.js";
  import { invoke, on } from "../../lib/ipc.js";
  import { log } from "../../lib/log.js";
  import { dashboardLayout, settingNumber, widgetSettings } from "../../stores/dashboard.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  // The dashboard.* keys land in en.json with this change; the cast keeps the
  // component compiling while the dictionary catches up.
  const k = (key: string): MessageKey => key as MessageKey;

  let hits = $state<MarketAlertHit[]>([]);
  let status = $state<MarketAlertEngineStatus | null>(null);
  let failed = $state(false);

  const settings = $derived(widgetSettings($dashboardLayout, "widget.marketAlerts"));
  const limit = $derived(settingNumber(settings, "limit", 5));
  const shown = $derived(hits.slice(0, limit));

  const healthKey = $derived.by((): MessageKey => {
    if (!status || !status.running) return "marketAlerts.engineStopped";
    if (status.scheduler.state === "backoff") return "marketAlerts.healthBackoff";
    if (status.scheduler.state === "degraded") return "marketAlerts.healthDegraded";
    return "marketAlerts.healthOk";
  });

  // Read-only, once per mount plus the engine's own change push. The engine owns
  // the polling; a widget adding its own interval would double the request rate.
  async function refresh(): Promise<void> {
    try {
      const [nextHits, nextStatus] = await Promise.all([
        invoke("marketAlertsGetHits"),
        invoke("marketAlertsStatus"),
      ]);
      hits = nextHits;
      status = nextStatus;
      failed = false;
    } catch (error) {
      log.warn("[Dashboard] market alert read failed:", error);
      failed = true;
    }
  }

  function hitTime(at: string): string {
    const parsed = new Date(at);
    return Number.isNaN(parsed.getTime())
      ? ""
      : parsed.toLocaleTimeString($locale, { hour: "2-digit", minute: "2-digit" });
  }

  onMount(() => {
    void refresh();
    return on("market-alerts:changed", () => void refresh());
  });
</script>

<WidgetFrame
  widgetId="widget.marketAlerts"
  errorKey={failed ? k("dashboard.widgetError") : null}
  empty={shown.length === 0}
  emptyKey="marketAlerts.noHits"
>
  {#snippet subtitle()}
    <p class="m-0 text-[11px] text-text-muted" data-widget-status>
      {$tr(healthKey)}
      {#if status}
        &middot; {$tr("marketAlerts.enabledCount", {
          enabled: String(status.enabledCount),
          total: String(status.ruleCount),
        })}
      {/if}
    </p>
  {/snippet}
  <ul class="m-0 flex list-none flex-col gap-1 p-0 text-xs">
    {#each shown as hit (hit.id)}
      <li class="flex items-baseline gap-2">
        <span class="shrink-0 text-text-muted">{hitTime(hit.at)}</span>
        <span class="min-w-0 flex-1 truncate text-text-secondary">{hit.ruleName}</span>
        {#if hit.platinum != null}
          <span class="shrink-0 font-display text-text-primary">{hit.platinum}</span>
        {/if}
      </li>
    {/each}
  </ul>
</WidgetFrame>
