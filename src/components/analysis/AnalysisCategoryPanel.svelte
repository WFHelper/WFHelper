<script lang="ts">
  import ThemedButton from "../ThemedButton.svelte";
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import {
    formatPlat,
    UNCATEGORIZED,
    type CategoryRollup,
  } from "../../lib/stats/tradeAnalytics.js";

  interface Props {
    rows: CategoryRollup[];
    onEdit: () => void;
  }

  let { rows, onEdit }: Props = $props();

  const max = $derived(rows.reduce((m, r) => Math.max(m, r.platIn + r.platOut), 0));

  function share(row: CategoryRollup): number {
    return max > 0 ? Math.max(2, ((row.platIn + row.platOut) / max) * 100) : 0;
  }
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-categories>
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {$tr("analysis.categories")}
      </span>
      <ThemedButton size="compact" onClick={onEdit}>{$tr("analysis.editCategories")}</ThemedButton>
    </div>

    {#if rows.length === 0}
      <p class="m-0 py-4 text-center text-sm text-text-muted">{$tr("analysis.noCategories")}</p>
    {:else}
      <div class="flex flex-col gap-1.5">
        {#each rows as row (row.category)}
          <div class="flex min-w-0 flex-col gap-1" data-analysis-category={row.category}>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <span class="truncate text-sm text-text-primary">
                {row.category === UNCATEGORIZED ? $tr("analysis.uncategorized") : row.category}
              </span>
              <span
                class="shrink-0 font-semibold tabular-nums {row.net >= 0
                  ? 'text-success'
                  : 'text-danger'}"
              >
                {formatPlat(row.net, $locale)}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <div
                class="flex h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[color:var(--ui-panel-border)]"
              >
                <div class="h-full bg-success opacity-75" style="width: {share(row)}%"></div>
              </div>
              <span class="shrink-0 text-[0.65rem] tabular-nums text-text-muted">
                {$tr("analysis.categoryDetail", {
                  sold: row.soldUnits,
                  bought: row.boughtUnits,
                  in: formatPlat(row.platIn, $locale),
                  out: formatPlat(row.platOut, $locale),
                })}
              </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</ThemedPanel>
