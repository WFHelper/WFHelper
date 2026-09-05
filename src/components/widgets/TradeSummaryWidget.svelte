<script lang="ts">
  import { onMount } from "svelte";

  import { tr } from "../../lib/i18n.js";
  import { log } from "../../lib/log.js";
  import { pageLedgerRange } from "../../lib/stats/ledgerPaging.js";
  import { computeFlow, type PlatFlow } from "../../lib/stats/tradeAnalytics.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  /** A month of trades is small; the cap only stops a pathological ledger. */
  const MAX_MONTH_EVENTS = 2000;

  let flow = $state<PlatFlow | null>(null);
  let failed = $state(false);

  const ledgerReady = typeof window.api?.ledgerQuery === "function";

  function monthStart(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return `${now.getFullYear()}-${month}-01`;
  }

  // One paged read per mount, no interval: the ledger only grows when a trade is
  // recorded, and the Analytics tab owns the deeper queries.
  async function loadMonth(): Promise<void> {
    if (!ledgerReady) return;
    const from = monthStart();
    try {
      const loaded = await pageLedgerRange({ from }, MAX_MONTH_EVENTS);
      flow = computeFlow(loaded?.events ?? []);
      failed = false;
    } catch (error) {
      log.warn("[Dashboard] ledger read failed:", error);
      failed = true;
    }
  }

  onMount(() => {
    void loadMonth();
  });
</script>

<WidgetFrame
  widgetId="widget.tradeSummary"
  errorKey={failed ? "dashboard.widgetError" : null}
  empty={!ledgerReady || flow === null || flow.events === 0}
  emptyKey={ledgerReady ? "common.noTradesYet" : "analysis.unavailable"}
>
  {#snippet subtitle()}
    <p class="m-0 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted" data-widget-status>
      {$tr("dashboard.thisMonth")}
    </p>
  {/snippet}
  {#if flow}
    <dl class="m-0 grid grid-cols-3 gap-2">
      <div class="min-w-0">
        <dt class="truncate text-[0.68rem] uppercase tracking-[0.06em] text-text-muted">
          {$tr("analysis.platIn")}
        </dt>
        <dd class="m-0 font-display text-lg tabular-nums text-text-primary">
          {flow.platIn.toLocaleString()}
        </dd>
      </div>
      <div class="min-w-0">
        <dt class="truncate text-[0.68rem] uppercase tracking-[0.06em] text-text-muted">
          {$tr("analysis.platOut")}
        </dt>
        <dd class="m-0 font-display text-lg tabular-nums text-text-primary">
          {flow.platOut.toLocaleString()}
        </dd>
      </div>
      <div class="min-w-0">
        <dt class="truncate text-[0.68rem] uppercase tracking-[0.06em] text-text-muted">
          {$tr("analysis.netPlat")}
        </dt>
        <dd class="m-0 font-display text-lg tabular-nums text-text-primary">
          {flow.net.toLocaleString()}
        </dd>
      </div>
    </dl>
    <p class="m-0 text-[0.68rem] text-text-muted">
      {$tr("analysis.salesCount", { count: String(flow.sales) })} &middot;
      {$tr("analysis.purchasesCount", { count: String(flow.purchases) })}
    </p>
  {/if}
</WidgetFrame>
