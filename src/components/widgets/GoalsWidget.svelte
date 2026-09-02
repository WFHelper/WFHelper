<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import { buildMasteryPlan, type PlannerPin } from "../../lib/masteryPlanner.js";
  import { componentOwnership, itemDb } from "../../stores/data.js";
  import { dashboardLayout, settingNumber, widgetSettings } from "../../stores/dashboard.js";
  import { masteryData } from "../../stores/mastery.js";
  import { masteryPins } from "../../stores/masteryPins.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  const settings = $derived(widgetSettings($dashboardLayout, "widget.goals"));
  const limit = $derived(settingNumber(settings, "limit", 5));

  const pins = $derived.by((): PlannerPin[] => {
    const items = $masteryData?.items ?? [];
    // Plain Map on purpose: it is rebuilt on every run of this derived and never
    // read outside it, so a reactive source per entry would only cost.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const byUniqueName = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      const key = item.uniqueName || item.internalName;
      if (key && !byUniqueName.has(key)) byUniqueName.set(key, item);
    }
    return $masteryPins.map((uniqueName) => {
      const match = byUniqueName.get(uniqueName);
      const entry = $itemDb[uniqueName];
      const displayName = match?.displayName || entry?.displayName;
      return {
        uniqueName,
        name: match?.name || entry?.name || uniqueName,
        ...(displayName ? { displayName } : {}),
        imageUrl: match?.imageUrl ?? entry?.imageUrl ?? null,
        masteryXpRemaining: match?.masteryXpRemaining ?? 0,
      };
    });
  });

  // One walk per pin over the item DB, same as the planner tab; pinning is rare
  // enough that this only runs when the pin list or the inventory moves.
  const plan = $derived(
    pins.length > 0
      ? buildMasteryPlan(pins, $itemDb, $componentOwnership)
      : { items: [], totals: [], totalCredits: 0, craftableCount: 0 },
  );
  const rows = $derived(
    [...plan.items].sort((a, b) => b.masteryXpRemaining - a.masteryXpRemaining).slice(0, limit),
  );
</script>

<WidgetFrame widgetId="widget.goals" empty={pins.length === 0} emptyKey="mastery.planner.empty">
  {#snippet subtitle()}
    <p class="m-0 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted" data-widget-status>
      {$tr("mastery.planner.pinnedCount", { count: String(pins.length) })} &middot;
      {$tr("mastery.planner.craftableCount", { count: String(plan.craftableCount) })}
    </p>
  {/snippet}
  <ul class="m-0 max-h-[340px] flex-1 list-none overflow-y-auto p-0">
    {#each rows as item (item.uniqueName)}
      <li class="flex items-baseline gap-2 py-1 text-sm">
        <span class="min-w-0 flex-1 truncate text-text-secondary"
          >{item.displayName || item.name}</span
        >
        {#if item.craftableNow}
          <span class="shrink-0 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted"
            >{$tr("mastery.planner.craftableNow")}</span
          >
        {/if}
        <span class="shrink-0 font-display tabular-nums text-text-primary"
          >{item.masteryXpRemaining.toLocaleString()}</span
        >
      </li>
    {/each}
  </ul>
</WidgetFrame>
