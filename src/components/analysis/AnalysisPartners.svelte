<script lang="ts">
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr as t } from "../../lib/i18n.js";
  import { formatPlat, type PartnerRollup } from "../../lib/stats/tradeAnalytics.js";
  import { ANALYSIS_MSG } from "./analysisMessages.js";

  interface Props {
    rows: PartnerRollup[];
  }

  let { rows }: Props = $props();

  const max = $derived(rows.reduce((m, r) => Math.max(m, r.total), 0));
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-partners>
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
      {$t(ANALYSIS_MSG.topPartners)}
    </span>

    {#if rows.length === 0}
      <p class="m-0 py-4 text-center text-sm text-text-muted">{$t(ANALYSIS_MSG.noPartners)}</p>
    {:else}
      <div class="min-w-0 overflow-x-auto">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="text-left text-[0.65rem] uppercase tracking-wide text-text-muted">
              <th class="py-1 pr-2 font-semibold">{$t("analysis.colPartner")}</th>
              <th class="whitespace-nowrap py-1 pr-2 text-right font-semibold">
                {$t("stats.filterSale")}
              </th>
              <th class="whitespace-nowrap py-1 pr-2 text-right font-semibold">
                {$t("stats.filterPurchase")}
              </th>
              <th class="whitespace-nowrap py-1 text-right font-semibold">{$t("common.total")}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.partner)}
              <tr
                class="border-t border-[color:var(--ui-panel-border)]"
                data-analysis-partner={row.partner || "?"}
              >
                <td class="max-w-[12rem] py-1 pr-2">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate text-text-primary" title={row.partner}>
                      {row.partner || $t("common.unknown")}
                    </span>
                    <span
                      class="h-0.5 rounded-full bg-accent opacity-60"
                      style="width: {max > 0 ? Math.max(3, (row.total / max) * 100) : 0}%"
                      aria-hidden="true"
                    ></span>
                  </span>
                </td>
                <td class="whitespace-nowrap py-1 pr-2 text-right tabular-nums text-success">
                  {formatPlat(row.salesPlat, $locale)}
                  <span class="text-text-muted">
                    {$t("analysis.unitsShort", { count: row.sales })}
                  </span>
                </td>
                <td class="whitespace-nowrap py-1 pr-2 text-right tabular-nums text-danger">
                  {formatPlat(row.purchasesPlat, $locale)}
                  <span class="text-text-muted">
                    {$t("analysis.unitsShort", { count: row.purchases })}
                  </span>
                </td>
                <td
                  class="whitespace-nowrap py-1 text-right font-semibold tabular-nums text-text-primary"
                >
                  {formatPlat(row.total, $locale)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</ThemedPanel>
