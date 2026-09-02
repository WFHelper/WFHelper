<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import {
    buildBaseInventoryItems,
    buildInventoryViewItems,
    buildOrderLookups,
    type InventoryFilterTab,
  } from "../../lib/inventoryMarket.js";
  import {
    computeInventoryValueTotals,
    isCountedForValue,
    type InventoryValueScope,
  } from "../../lib/inventory/valueTotals.js";
  import { parsedItems, wfmItems } from "../../stores/data.js";
  import { dashboardLayout, settingBoolean, widgetSettings } from "../../stores/dashboard.js";
  import { getInventoryHydrationController } from "../../stores/inventoryHydration.js";
  import { marketOrders } from "../../stores/market.js";
  import { relicDb } from "../../stores/relics.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  // Read-only view of the shared hydration controller: the Inventory tab owns
  // the queue, so nothing here enqueues work or touches the network.
  const hydrationMetrics = getInventoryHydrationController().metricsByKey;

  const settings = $derived(widgetSettings($dashboardLayout, "widget.inventoryValue"));
  const allTradables = $derived(settingBoolean(settings, "allTradables", false));
  const scope: InventoryValueScope = $derived(allTradables ? "tradable" : "prime");
  const sourceTab: InventoryFilterTab = $derived(allTradables ? "everything" : "all_parts");
  const lookups = $derived(buildOrderLookups($marketOrders));

  // Same pipeline as the Inventory value strip; the cheap base rows are gated
  // first so the priced rows are only built for what the totals actually count.
  const baseRows = $derived(
    buildBaseInventoryItems(
      $parsedItems,
      sourceTab,
      $wfmItems,
      lookups.orderedNames,
      lookups.orderedSlugs,
      $relicDb,
      lookups.orderedSubtypes,
    ).filter((item) => isCountedForValue(item, scope)),
  );
  const totals = $derived(
    computeInventoryValueTotals(buildInventoryViewItems(baseRows, $hydrationMetrics), scope),
  );
</script>

<WidgetFrame
  widgetId="widget.inventoryValue"
  empty={totals.counted === 0}
  emptyKey="app.noInventoryLoaded"
>
  {#snippet subtitle()}
    <p class="m-0 text-[11px] text-text-muted" data-widget-status>
      {allTradables ? $tr("inventory.value.allTradables") : $tr("inventory.value.scopePrime")}
    </p>
  {/snippet}
  <dl class="m-0 grid grid-cols-2 gap-2">
    <div class="min-w-0">
      <dt class="text-[11px] uppercase tracking-wide text-text-muted">{$tr("common.platinum")}</dt>
      <dd class="m-0 font-display text-lg text-text-primary">
        {totals.platinum.toLocaleString()}
      </dd>
    </div>
    <div class="min-w-0">
      <dt class="text-[11px] uppercase tracking-wide text-text-muted">{$tr("common.ducats")}</dt>
      <dd class="m-0 font-display text-lg text-text-primary">{totals.ducats.toLocaleString()}</dd>
    </div>
  </dl>
  {#if totals.unpriced > 0}
    <p class="m-0 text-[11px] text-text-muted">
      {$tr("inventory.value.unpriced", { count: String(totals.unpriced) })}
    </p>
  {/if}
</WidgetFrame>
