<script lang="ts">
  import {
    chainBuildableBlueprints,
    isFoundryRecipeReady,
  } from "../../lib/inventory/foundryResources.js";
  import { tr } from "../../lib/i18n.js";
  import { dashboardLayout, settingNumber, widgetSettings } from "../../stores/dashboard.js";
  import { componentOwnership, foundryData, itemDb } from "../../stores/data.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  interface Props {
    nowCoarseMs: number;
  }

  const { nowCoarseMs }: Props = $props();

  interface ReadyRow {
    key: string;
    name: string;
    claimable: boolean;
  }

  const settings = $derived(widgetSettings($dashboardLayout, "widget.foundryReady"));
  const limit = $derived(settingNumber(settings, "limit", 5));
  const foundry = $derived($foundryData);
  // Kept out of the clock-driven derived below: walking the recipe chain is the
  // expensive half and only moves when the inventory or the item DB does.
  const chainBuildable = $derived(
    chainBuildableBlueprints(foundry.recipes, $componentOwnership, $itemDb),
  );

  const rows = $derived.by((): ReadyRow[] => {
    const claimable = foundry.building
      .filter((entry) => entry.endDate != null && entry.endDate.getTime() <= nowCoarseMs)
      .map((entry) => ({
        key: `building:${entry.productUniqueName ?? entry.name}`,
        name: entry.displayName || entry.name,
        claimable: true,
      }));
    const buildable = foundry.recipes
      .filter((recipe) => isFoundryRecipeReady(recipe, $componentOwnership, chainBuildable))
      .map((recipe) => ({
        key: `recipe:${recipe.uniqueName ?? recipe.name}`,
        name: recipe.displayName || recipe.name,
        claimable: false,
      }));
    return [...claimable, ...buildable];
  });

  const shown = $derived(rows.slice(0, limit));
</script>

<WidgetFrame widgetId="widget.foundryReady" empty={rows.length === 0} emptyKey="foundry.noItems">
  <ul class="m-0 max-h-[340px] flex-1 list-none overflow-y-auto p-0">
    {#each shown as row (row.key)}
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
  {#if rows.length > shown.length}
    <p class="m-0 text-right text-[0.68rem] text-text-muted" data-widget-more>
      {$tr("mastery.planner.moreMaterials", { count: String(rows.length - shown.length) })}
    </p>
  {/if}
</WidgetFrame>
