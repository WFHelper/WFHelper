<script lang="ts">
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import {
    flowAxis,
    flowBarHeight,
    flowBarX,
    FLOW_BAR,
    FLOW_HEIGHT,
  } from "../../lib/stats/chartData.js";
  import {
    formatPlat,
    parseDateKey,
    type DayFlow,
    type PlatFlow,
  } from "../../lib/stats/tradeAnalytics.js";
  import { ANALYSIS_MSG } from "./analysisMessages.js";

  interface Props {
    days: DayFlow[];
    today: PlatFlow;
    /** These days come from the year-comparison load, which can still be running
     *  or have failed while the monthly chart beside it is fine. */
    loading?: boolean;
    failed?: boolean;
  }

  let { days, today, loading = false, failed = false }: Props = $props();

  interface Bar {
    day: string;
    x: number;
    inY: number;
    inH: number;
    outH: number;
  }

  interface Chart {
    width: number;
    zeroY: number;
    bars: Bar[];
  }

  const chart = $derived.by<Chart>(() => {
    const up = days.reduce((m, d) => Math.max(m, d.platIn), 0);
    const down = days.reduce((m, d) => Math.max(m, d.platOut), 0);
    const { width, zeroY, span } = flowAxis(days.length, up, down);
    if (span <= 0) return { width, zeroY, bars: [] };
    const bars = days.map((day, index) => {
      // A day with no flow on one side draws nothing there, not a sliver.
      const inH = day.platIn > 0 ? flowBarHeight(day.platIn, span) : 0;
      const outH = day.platOut > 0 ? flowBarHeight(day.platOut, span) : 0;
      return { day: day.day, x: flowBarX(index), inY: zeroY - inH, inH, outH };
    });
    return { width, zeroY, bars };
  });

  function dayLabel(day: string, loc: string): string {
    const parts = parseDateKey(day);
    if (!parts) return day;
    return new Date(parts.year, parts.month - 1, parts.day).toLocaleDateString(loc, {
      month: "short",
      day: "numeric",
    });
  }
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-recent-days>
    {#if loading || failed}
      <p
        class="m-0 py-6 text-center text-sm {failed ? 'text-danger' : 'text-text-muted'}"
        data-analysis-recent-status={failed ? "failed" : "loading"}
      >
        {failed ? $tr("analysis.loadFailed") : $tr("common.loading")}
      </p>
    {:else}
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {$tr("analysis.lastDays", { count: days.length })}
        </span>
        <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {$tr("stats.today")}
        </span>
      </div>

      <div class="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1" data-analysis-today>
        <span class="text-xs text-success">
          {$tr("analysis.salesCount", { count: today.sales })}
        </span>
        <span class="text-xs text-danger">
          {$tr("analysis.purchasesCount", { count: today.purchases })}
        </span>
        <span class="flex items-baseline gap-1.5">
          <span class="text-[0.65rem] uppercase tracking-wide text-text-muted">
            {$tr("analysis.colProfit")}
          </span>
          <span
            class="font-display text-2xl font-bold leading-none {today.net >= 0
              ? 'text-success'
              : 'text-danger'}"
          >
            {formatPlat(today.net, $locale)}
          </span>
        </span>
      </div>

      {#if chart.bars.length === 0}
        <p class="m-0 py-6 text-center text-sm text-text-muted">{$tr("stats.noDataTimeframe")}</p>
      {:else}
        <svg
          class="block h-24 w-full"
          viewBox="0 0 {chart.width} {FLOW_HEIGHT}"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1="0"
            y1={chart.zeroY}
            x2={chart.width}
            y2={chart.zeroY}
            stroke="var(--border)"
            stroke-width="0.5"
          />
          {#each chart.bars as bar, index (bar.day)}
            {@const row = days[index]}
            {@const title = $tr("analysis.flowDetail", {
              label: dayLabel(bar.day, $locale),
              in: formatPlat(row.platIn, $locale),
              out: formatPlat(row.platOut, $locale),
              net: formatPlat(row.net, $locale),
            })}
            {#if bar.inH > 0}
              <rect
                x={bar.x}
                y={bar.inY}
                width={FLOW_BAR}
                height={bar.inH}
                class="fill-success opacity-75"
              >
                <title>{title}</title>
              </rect>
            {/if}
            {#if bar.outH > 0}
              <rect
                x={bar.x}
                y={chart.zeroY}
                width={FLOW_BAR}
                height={bar.outH}
                class="fill-danger opacity-75"
              >
                <title>{title}</title>
              </rect>
            {/if}
          {/each}
        </svg>
        <div class="flex min-w-0">
          {#each days as day, index (day.day)}
            <span class="min-w-0 flex-1 truncate text-center text-[0.6rem] text-text-muted">
              {index % 2 === 0 ? dayLabel(day.day, $locale) : ""}
            </span>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</ThemedPanel>
