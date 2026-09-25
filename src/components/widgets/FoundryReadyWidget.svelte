<script lang="ts">
  import { chainBuildableBlueprints } from "../../lib/inventory/foundryResources.js";
  import { tr } from "../../lib/i18n.js";
  import { foundryReadyRows } from "../../lib/widgets/rows.js";
  import { dashboardLayout, settingNumber, widgetSettings } from "../../stores/dashboard.js";
  import { componentOwnership, foundryData, itemDb } from "../../stores/data.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  interface Props {
    nowCoarseMs: number;
  }

  const { nowCoarseMs }: Props = $props();

  const settings = $derived(widgetSettings($dashboardLayout, "widget.foundryReady"));
  const limit = $derived(settingNumber(settings, "limit", 5));
  const foundry = $derived($foundryData);
  // Kept out of the clock-driven derived below: walking the recipe chain is the
  // expensive half and only moves when the inventory or the item DB does.
  const chainBuildable = $derived(
    chainBuildableBlueprints(foundry.recipes, $componentOwnership, $itemDb),
  );

  const rows = $derived(
    foundryReadyRows(foundry, $componentOwnership, chainBuildable, nowCoarseMs),
  );

  const shown = $derived(rows.slice(0, limit));
</script>

<WidgetFrame
  widgetId="widget.foundryReady"
  empty={rows.length === 0}
  emptyKey="foundry.noItems"
  overflow={rows.length - shown.length}
>
  <ul class="m-0 max-h-[340px] flex-1 list-none overflow-y-auto p-0">
    {#each shown as row (row.rowKey)}
      <li class="flex items-baseline gap-2 py-1 text-sm">
        <span class="min-w-0 flex-1 truncate text-text-secondary">{row.name}</span>
        <span class="shrink-0 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted">
          {row.claimable
            ? $tr("mastery.roadmap.accessClaimable")
            : $tr("foundry.status.readyToBuild")}
        </span>
      </li>
    {/each}
  </ul>
</WidgetFrame>
