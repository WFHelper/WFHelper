<script lang="ts">
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import { formatPlat, type WorthTodayResult } from "../../lib/stats/tradeAnalytics.js";

  interface Props {
    worth: WorthTodayResult;
  }

  let { worth }: Props = $props();

  const delta = $derived(worth.totalWorth - worth.realized);
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-worth>
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {$tr("analysis.worthToday")}
      </span>
      <!-- The median is read from the bare slug, so it is whatever rank sold last. -->
      <span class="text-[0.65rem] text-text-muted">
        {$tr("analysis.worthTodayHint")} · {$tr("analysis.worthTodayUnranked")}
      </span>
    </div>

    <div class="flex flex-wrap items-baseline gap-x-5 gap-y-1">
      <span class="flex items-baseline gap-1.5">
        <span class="text-[0.65rem] uppercase tracking-wide text-text-muted">
          {$tr("analysis.worthNow")}
        </span>
        <span class="font-display text-2xl font-bold leading-none text-text-primary">
          {formatPlat(worth.totalWorth, $locale)}
        </span>
      </span>
      <span class="flex items-baseline gap-1.5">
        <span class="text-[0.65rem] uppercase tracking-wide text-text-muted">
          {$tr("analysis.worthRealized")}
        </span>
        <span class="text-lg font-semibold leading-none text-text-secondary">
          {formatPlat(worth.realized, $locale)}
        </span>
      </span>
      {#if worth.pricedUnits > 0}
        <span class="text-xs font-semibold {delta >= 0 ? 'text-success' : 'text-danger'}">
          {$tr("analysis.worthDelta", { plat: formatPlat(delta, $locale) })}
        </span>
      {/if}
    </div>

    <!-- Unpriced rows are stated outright; a missing median is never a zero. -->
    <p class="m-0 text-xs text-warning" data-analysis-worth-unpriced>
      {#if worth.unpricedRows > 0}
        {$tr("analysis.unpricedRows", {
          rows: worth.unpricedRows,
          units: worth.unpricedUnits,
        })}
      {:else if worth.pricedUnits === 0}
        {$tr("analysis.noPricesYet")}
      {:else}
        <span class="text-text-muted">{$tr("analysis.allRowsPriced")}</span>
      {/if}
    </p>

    {#if worth.rows.length > 0}
      <div class="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {#each worth.rows as row (row.key)}
          <div
            class="grid grid-cols-[1fr_auto_auto] items-baseline gap-2 text-xs"
            data-analysis-worth-row={row.key}
          >
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span class="truncate text-text-secondary" title={row.name}>{row.name}</span>
              {#if row.secondary}
                <span class="truncate text-[0.65rem] text-text-muted">{row.secondary}</span>
              {/if}
            </span>
            <span class="tabular-nums text-text-muted">
              {$tr("analysis.unitsShort", { count: row.units })}
            </span>
            <span
              class="w-20 text-right tabular-nums {row.worth == null
                ? 'text-text-muted'
                : 'text-text-primary'}"
            >
              {row.worth == null ? $tr("analysis.noPrice") : formatPlat(row.worth, $locale)}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</ThemedPanel>
