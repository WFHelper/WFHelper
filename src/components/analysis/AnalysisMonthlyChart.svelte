<script lang="ts">
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import { formatPlat, type MonthFlow } from "../../lib/stats/tradeAnalytics.js";
  import { ANALYSIS_MSG } from "./analysisMessages.js";

  interface Props {
    rows: MonthFlow[];
  }

  let { rows }: Props = $props();

  const SLOT = 10;
  const BAR = 6.5;
  const HEIGHT = 100;

  interface Bar {
    month: string;
    x: number;
    y: number;
    h: number;
    positive: boolean;
  }

  interface Chart {
    width: number;
    zeroY: number;
    bars: Bar[];
  }

  const chart = $derived.by<Chart>(() => {
    const width = Math.max(1, rows.length) * SLOT;
    const up = rows.reduce((m, r) => Math.max(m, r.net), 0);
    const down = rows.reduce((m, r) => Math.max(m, -r.net), 0);
    const span = up + down;
    if (span <= 0) return { width, zeroY: HEIGHT, bars: [] };
    const zeroY = (up / span) * HEIGHT;
    const bars = rows.map((row, index) => {
      // A tiny month still needs a visible sliver, so every bar keeps 1 unit.
      const h = Math.max(1, (Math.abs(row.net) / span) * HEIGHT);
      return {
        month: row.month,
        x: index * SLOT + (SLOT - BAR) / 2,
        y: row.net >= 0 ? zeroY - h : zeroY,
        h,
        positive: row.net >= 0,
      };
    });
    return { width, zeroY, bars };
  });

  // Every label would collide once a long archive is in range.
  const labelStep = $derived(Math.max(1, Math.ceil(rows.length / 12)));

  function monthLabel(month: string, loc: string): string {
    const parts = parseDateKey(month);
    if (!parts) return month;
    const short = new Date(parts.year, parts.month - 1, 1).toLocaleDateString(loc, {
      month: "short",
    });
    return parts.month === 1 ? `${short} ${String(parts.year).slice(2)}` : short;
  }
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-monthly>
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
      {$tr(ANALYSIS_MSG.netByMonth)}
    </span>

    {#if chart.bars.length === 0}
      <p class="m-0 py-6 text-center text-sm text-text-muted">{$tr("stats.noDataTimeframe")}</p>
    {:else}
      <svg
        class="block h-32 w-full"
        viewBox="0 0 {chart.width} {HEIGHT}"
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
        {#each chart.bars as bar, index (bar.month)}
          {@const row = rows[index]}
          <rect
            x={bar.x}
            y={bar.y}
            width={BAR}
            height={bar.h}
            class={bar.positive ? "fill-success opacity-75" : "fill-danger opacity-75"}
          >
            <title>
              {$tr(ANALYSIS_MSG.flowDetail, {
                label: monthLabel(bar.month, $locale),
                in: formatPlat(row.platIn, $locale),
                out: formatPlat(row.platOut, $locale),
                net: formatPlat(row.net, $locale),
              })}
            </title>
          </rect>
        {/each}
      </svg>
      <div class="flex min-w-0">
        {#each rows as row, index (row.month)}
          <span class="min-w-0 flex-1 truncate text-center text-[0.6rem] text-text-muted">
            {index % labelStep === 0 ? monthLabel(row.month, $locale) : ""}
          </span>
        {/each}
      </div>
    {/if}
  </div>
</ThemedPanel>
