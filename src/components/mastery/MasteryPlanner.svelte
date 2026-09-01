<script lang="ts">
  import ItemImage from "../ItemImage.svelte";
  import SegmentedControl from "../SegmentedControl.svelte";
  import { itemLabel } from "../../lib/itemLabel.js";
  import { locale, tr } from "../../lib/i18n.js";
  import {
    sortPlannedItems,
    type MasteryPlan,
    type PlannerSort,
  } from "../../lib/masteryPlanner.js";
  import type { ComponentInfo } from "../../types/inventory.js";

  interface Props {
    plan: MasteryPlan;
    sort: PlannerSort;
    onSort: (value: PlannerSort) => void;
    onUnpin: (uniqueName: string) => void;
    onOpenItem: (uniqueName: string) => void;
    onOpenComponent: (comp: ComponentInfo, parentName: string) => void;
  }

  let { plan, sort, onSort, onUnpin, onOpenItem, onOpenComponent }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});

  const sortedItems = $derived(sortPlannedItems(plan.items, sort, itemLabel));
  const sortOptions = $derived([
    { value: "mastery_xp" as const, label: $tr("mastery.sort.masteryXp") },
    { value: "completeness" as const, label: $tr("mastery.planner.sortCompleteness") },
    { value: "name" as const, label: $tr("common.name") },
  ]);

  function barWidth(owned: number, needed: number): number {
    if (needed <= 0) return 100;
    return Math.max(0, Math.min(100, (owned / needed) * 100));
  }

  function toggleRow(uniqueName: string): void {
    expanded[uniqueName] = !expanded[uniqueName];
  }

  // The detail modal keys off ComponentInfo, so a planner row hands it the same
  // shape the collection cards do.
  function asComponentInfo(entry: {
    uniqueName: string;
    name: string;
    displayName?: string;
    needed: number;
    owned: number;
    missing: number;
  }): ComponentInfo {
    return {
      name: entry.name,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      uniqueName: entry.uniqueName,
      itemCount: entry.needed,
      ownedCount: entry.owned,
      owned: entry.missing === 0,
    };
  }
</script>

{#if plan.items.length === 0}
  <div class="empty-state"><p>{$tr("mastery.planner.empty")}</p></div>
{:else}
  <div class="grid gap-3">
    <div class="planner-panel grid gap-2 p-3" data-planner-totals>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-display text-sm font-semibold text-text-secondary"
          >{$tr("mastery.planner.combinedMaterials")}</span
        >
        <div class="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span>{$tr("mastery.planner.pinnedCount", { count: plan.items.length })}</span>
          <span>{$tr("mastery.planner.craftableCount", { count: plan.craftableCount })}</span>
          {#if plan.totalCredits > 0}
            <span>{$tr("common.credits")}: {plan.totalCredits.toLocaleString($locale)}</span>
          {/if}
          <SegmentedControl value={sort} options={sortOptions} onChange={onSort} />
        </div>
      </div>

      {#if plan.totals.length === 0}
        <p class="text-xs text-text-muted">{$tr("mastery.planner.noMaterialsNeeded")}</p>
      {:else}
        {#each plan.totals as row (row.uniqueName)}
          {@const width = barWidth(row.owned, row.needed)}
          <div class="grid items-center gap-2 grid-cols-[minmax(110px,180px)_1fr_auto]">
            <span class="truncate text-xs text-text-secondary" title={itemLabel(row)}
              >{itemLabel(row)}</span
            >
            <svg
              class="block h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]"
              viewBox="0 0 100 1"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect
                class={row.missing > 0 ? "fill-warning" : "fill-success"}
                x="0"
                y="0"
                {width}
                height="1"
              ></rect>
            </svg>
            <span
              class="whitespace-nowrap text-xs {row.missing > 0
                ? 'text-warning'
                : 'text-text-secondary'}"
              >{row.owned.toLocaleString($locale)}/{row.needed.toLocaleString($locale)}</span
            >
          </div>
        {/each}
      {/if}
    </div>

    {#each sortedItems as item (item.uniqueName)}
      {@const open = expanded[item.uniqueName] === true}
      <div class="planner-panel overflow-hidden" data-planner-row={item.uniqueName}>
        <div class="flex items-center gap-2 p-2">
          <button
            type="button"
            class="flex flex-1 items-center gap-2.5 bg-transparent text-left"
            aria-expanded={open}
            aria-label={$tr("mastery.planner.toggleRow", { name: itemLabel(item) })}
            onclick={() => toggleRow(item.uniqueName)}
          >
            <span class="h-10 w-10 shrink-0">
              <ItemImage src={item.imageUrl} alt={itemLabel(item)} auditKey={item.name} />
            </span>
            <span class="grid gap-0.5">
              <span class="font-display text-sm font-semibold text-text-primary"
                >{itemLabel(item)}</span
              >
              <span class="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
                {#if item.masteryXpRemaining > 0}
                  <span class="planner-badge xp"
                    >{$tr("mastery.roadmap.xpAmount", {
                      amount: item.masteryXpRemaining.toLocaleString($locale),
                    })}</span
                  >
                {/if}
                {#if !item.hasRecipe}
                  <span>{$tr("mastery.planner.noRecipe")}</span>
                {:else if item.craftableNow}
                  <span class="planner-badge ready">{$tr("mastery.planner.craftableNow")}</span>
                {:else}
                  <span>{Math.round(item.completeness * 100)}%</span>
                {/if}
              </span>
            </span>
          </button>
          <button
            type="button"
            class="planner-icon-button"
            title={$tr("common.openDetailsFor", { name: itemLabel(item) })}
            aria-label={$tr("common.openDetailsFor", { name: itemLabel(item) })}
            onclick={() => onOpenItem(item.uniqueName)}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              class="h-3.5 w-3.5"
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7v4M8 5h.01" />
            </svg>
          </button>
          <button
            type="button"
            class="planner-icon-button"
            title={$tr("mastery.planner.unpin")}
            aria-label={$tr("mastery.planner.unpin")}
            data-mastery-pin={item.uniqueName}
            onclick={() => onUnpin(item.uniqueName)}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              class="h-3.5 w-3.5"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {#if open && item.hasRecipe}
          <div class="grid gap-2 border-t border-white/[0.07] p-2.5">
            {#if item.components.length > 0}
              <span class="font-display text-xs font-semibold text-text-secondary"
                >{$tr("mastery.planner.parts")}</span
              >
              <div class="flex flex-wrap gap-1.5">
                {#each item.components as comp (comp.uniqueName)}
                  <button
                    type="button"
                    class="planner-chip {comp.missing === 0 ? 'satisfied' : 'short'}"
                    aria-label={$tr("mastery.openComponentDetailsAria", {
                      name: itemLabel(comp) || $tr("mastery.componentFallback"),
                    })}
                    onclick={() => onOpenComponent(asComponentInfo(comp), item.name)}
                  >
                    <span class="truncate">{itemLabel(comp)}</span>
                    <span class="tabular-nums opacity-80">{comp.owned}/{comp.needed}</span>
                  </button>
                {/each}
              </div>
            {/if}

            {#if item.resources.length > 0}
              <span class="font-display text-xs font-semibold text-text-secondary"
                >{$tr("mastery.planner.itemMaterials")}</span
              >
              <div class="grid gap-1">
                {#each item.resources as row (row.uniqueName)}
                  <button
                    type="button"
                    class="grid items-center gap-2 bg-transparent text-left grid-cols-[minmax(110px,180px)_1fr_auto]"
                    aria-label={$tr("mastery.openComponentDetailsAria", {
                      name: itemLabel(row) || $tr("mastery.componentFallback"),
                    })}
                    onclick={() => onOpenComponent(asComponentInfo(row), item.name)}
                  >
                    <span class="truncate text-xs text-text-secondary">{itemLabel(row)}</span>
                    <svg
                      class="block h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]"
                      viewBox="0 0 100 1"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <rect
                        class={row.missing > 0 ? "fill-warning" : "fill-success"}
                        x="0"
                        y="0"
                        width={barWidth(row.owned, row.needed)}
                        height="1"
                      ></rect>
                    </svg>
                    <span
                      class="whitespace-nowrap text-xs {row.missing > 0
                        ? 'text-warning'
                        : 'text-text-secondary'}"
                      >{row.owned.toLocaleString($locale)}/{row.needed.toLocaleString(
                        $locale,
                      )}</span
                    >
                  </button>
                {/each}
              </div>
            {/if}

            {#if item.credits > 0}
              <span class="text-xs text-text-muted"
                >{$tr("common.credits")}: {item.credits.toLocaleString($locale)}</span
              >
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .planner-panel {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-surface);
  }

  .planner-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.5rem;
    width: 1.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.25);
    color: var(--text-muted);
    cursor: pointer;
  }
  .planner-icon-button:hover {
    color: var(--accent);
    border-color: var(--accent-dim);
  }

  .planner-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    max-width: 15rem;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    padding: 0.1rem 0.4rem;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .planner-chip.satisfied {
    color: color-mix(in oklab, var(--success) 88%, white);
    border-color: color-mix(in oklab, var(--success) 40%, transparent);
    background: color-mix(in oklab, var(--success) 12%, transparent);
  }
  .planner-chip.short {
    color: color-mix(in oklab, var(--danger) 88%, white);
    border-color: color-mix(in oklab, var(--danger) 40%, transparent);
    background: color-mix(in oklab, var(--danger) 12%, transparent);
  }

  .planner-badge {
    display: inline-flex;
    align-items: center;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    padding: 0.02rem 0.3rem;
    font-family: var(--font-display);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    line-height: 1.3;
  }
  .planner-badge.xp {
    color: color-mix(in oklab, var(--accent) 86%, white);
    border-color: color-mix(in oklab, var(--accent) 42%, transparent);
    background: color-mix(in oklab, var(--accent) 14%, transparent);
  }
  .planner-badge.ready {
    color: color-mix(in oklab, var(--success) 86%, white);
    border-color: color-mix(in oklab, var(--success) 40%, transparent);
    background: color-mix(in oklab, var(--success) 14%, transparent);
  }
</style>
