<script lang="ts">
  import SummaryStrip, { type SummaryStripItem } from "../SummaryStrip.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import {
    formatPct,
    formatPlat,
    type CostBasisResult,
    type ItemRollup,
    type PlatFlow,
  } from "../../lib/stats/tradeAnalytics.js";

  interface Props {
    flow: PlatFlow;
    basis: CostBasisResult;
    best: ItemRollup | null;
  }

  let { flow, basis, best }: Props = $props();

  const marginPct = $derived(formatPct(basis.estimatedMarginPct, $locale));

  const items = $derived<SummaryStripItem[]>([
    {
      key: "platIn",
      label: $tr("analysis.platIn"),
      value: formatPlat(flow.platIn, $locale),
      tone: "success",
      subtext: $tr("analysis.salesCount", { count: flow.sales }),
    },
    {
      key: "platOut",
      label: $tr("analysis.platOut"),
      value: formatPlat(flow.platOut, $locale),
      tone: "danger",
      subtext: $tr("analysis.purchasesCount", { count: flow.purchases }),
    },
    {
      key: "net",
      label: $tr("analysis.netPlat"),
      value: formatPlat(flow.net, $locale),
      tone: flow.net >= 0 ? "success" : "danger",
      subtext: $tr("analysis.activeDays", { count: flow.activeDays }),
    },
    {
      key: "volume",
      label: $tr("analysis.volume"),
      value: formatPlat(flow.volume, $locale),
      subtext: $tr("analysis.tradeCount", { count: flow.events }),
    },
    {
      key: "margin",
      label: $tr("analysis.estMargin"),
      value: formatPlat(basis.estimatedMargin, $locale),
      tone: basis.estimatedMargin >= 0 ? "success" : "danger",
      subtext: marginPct ?? $tr("analysis.marginPctUnknown"),
      subtextTone: marginPct ? "default" : "warning",
    },
    {
      key: "best",
      label: $tr("analysis.bestSeller"),
      value: best ? best.name : $tr("common.none"),
      subtext: best
        ? $tr("analysis.bestSellerDetail", {
            units: best.units,
            plat: formatPlat(best.platinum, $locale),
          })
        : $tr("analysis.noSalesYet"),
    },
  ]);
</script>

<div class="flex flex-col gap-2" data-analysis-summary>
  <SummaryStrip {items} variant="grid" />

  <!-- Never let the margin tile stand without its caveats. -->
  <div
    class="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-text-muted"
    data-analysis-estimate-note
  >
    <span
      class="rounded-[var(--radius-md)] border border-[color:var(--ui-control-border)] px-1.5 py-0.5 font-semibold uppercase tracking-wide text-warning"
    >
      {$tr("analysis.estimatedBadge")}
    </span>
    <span>{$tr("analysis.estimatedNote")}</span>
    {#if basis.unpricedUnits > 0}
      <span data-analysis-unpriced-units>
        {$tr("analysis.unpricedUnits", {
          count: basis.unpricedUnits,
          plat: formatPlat(basis.unpricedRevenue, $locale),
        })}
      </span>
    {/if}
    {#if basis.heldUnits > 0}
      <span>
        {$tr("analysis.heldUnits", {
          count: basis.heldUnits,
          plat: formatPlat(basis.heldCost, $locale),
        })}
      </span>
    {/if}
    {#if basis.swappedUnits > 0}
      <span>{$tr("analysis.swappedUnits", { count: basis.swappedUnits })}</span>
    {/if}
  </div>
</div>
