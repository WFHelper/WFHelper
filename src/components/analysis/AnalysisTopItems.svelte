<script lang="ts">
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { formatPlat, type ItemRollup } from "../../lib/stats/tradeAnalytics.js";

  interface Props {
    titleKey: MessageKey;
    rows: ItemRollup[];
    side: "sold" | "bought";
  }

  let { titleKey, rows, side }: Props = $props();

  const max = $derived(rows.reduce((m, r) => Math.max(m, r.platinum), 0));
  const barClass = $derived(side === "sold" ? "bg-success" : "bg-danger");
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-top-items={side}>
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {$tr(titleKey)}
      </span>
      <span class="text-[0.65rem] text-text-muted">{$tr("analysis.allocationNote")}</span>
    </div>

    {#if rows.length === 0}
      <p class="m-0 py-4 text-center text-sm text-text-muted">{$tr("analysis.noItems")}</p>
    {:else}
      <ol class="m-0 flex list-none flex-col gap-1.5 p-0">
        {#each rows as row (row.key)}
          <li class="flex min-w-0 flex-col gap-1" data-analysis-top-item={row.key}>
            <div class="flex min-w-0 items-baseline justify-between gap-2">
              <span class="truncate text-sm text-text-primary" title={row.name}>{row.name}</span>
              <span class="shrink-0 font-semibold tabular-nums text-text-primary">
                {formatPlat(row.platinum, $locale)}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <div class="h-1 min-w-0 flex-1 rounded-full bg-[color:var(--ui-panel-border)]">
                <div
                  class="h-full rounded-full {barClass} opacity-75"
                  style="width: {max > 0 ? Math.max(2, (row.platinum / max) * 100) : 0}%"
                ></div>
              </div>
              <span class="shrink-0 text-[0.65rem] tabular-nums text-text-muted">
                {$tr("analysis.unitsAndAvg", {
                  units: row.units,
                  avg: row.avgUnitPlat == null ? "-" : formatPlat(row.avgUnitPlat, $locale),
                })}
              </span>
            </div>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</ThemedPanel>
