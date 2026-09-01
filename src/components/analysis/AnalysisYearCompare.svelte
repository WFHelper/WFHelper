<script lang="ts">
  import ThemedPanel from "../ThemedPanel.svelte";
  import { locale, tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import { formatPct, formatPlat, type YearComparison } from "../../lib/stats/tradeAnalytics.js";

  interface Props {
    comparison: YearComparison;
  }

  let { comparison }: Props = $props();

  interface Line {
    key: string;
    labelKey: MessageKey;
    current: number;
    previous: number;
    pct: number | null;
  }

  const lines = $derived<Line[]>([
    {
      key: "platIn",
      labelKey: "analysis.platIn",
      current: comparison.current.platIn,
      previous: comparison.previous.platIn,
      pct: null,
    },
    {
      key: "platOut",
      labelKey: "analysis.platOut",
      current: comparison.current.platOut,
      previous: comparison.previous.platOut,
      pct: null,
    },
    {
      key: "net",
      labelKey: "analysis.netPlat",
      current: comparison.current.net,
      previous: comparison.previous.net,
      pct: comparison.netDeltaPct,
    },
    {
      key: "volume",
      labelKey: "analysis.volume",
      current: comparison.current.volume,
      previous: comparison.previous.volume,
      pct: comparison.volumeDeltaPct,
    },
    {
      key: "trades",
      labelKey: "analysis.tradesLabel",
      current: comparison.current.events,
      previous: comparison.previous.events,
      pct: null,
    },
  ]);
</script>

<ThemedPanel className="flex min-w-0 flex-col p-3">
  <div class="flex min-w-0 flex-col gap-2" data-analysis-year>
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">
      {$tr("analysis.yearCompare")}
    </span>

    {#if !comparison.hasPrevious}
      <p class="m-0 text-xs text-text-muted" data-analysis-year-empty>
        {$tr("analysis.noPreviousYear", { year: comparison.previousYear })}
      </p>
    {/if}

    <div class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 gap-y-1 text-sm">
      <span></span>
      <span class="text-right text-[0.65rem] uppercase tracking-wide text-text-muted">
        {comparison.currentYear}
        <span class="block normal-case text-text-muted">{$tr("analysis.yearToDate")}</span>
      </span>
      <span class="text-right text-[0.65rem] uppercase tracking-wide text-text-muted">
        {comparison.previousYear}
      </span>
      <span class="text-right text-[0.65rem] uppercase tracking-wide text-text-muted">
        {$tr("analysis.change")}
      </span>

      {#each lines as line (line.key)}
        {@const pct = formatPct(line.pct, $locale)}
        <span class="truncate text-text-secondary" data-analysis-year-row={line.key}>
          {$tr(line.labelKey)}
        </span>
        <span class="text-right tabular-nums text-text-primary">
          {formatPlat(line.current, $locale)}
        </span>
        <span class="text-right tabular-nums text-text-muted">
          {formatPlat(line.previous, $locale)}
        </span>
        <span
          class="text-right text-xs tabular-nums {line.pct == null
            ? 'text-text-muted'
            : line.pct >= 0
              ? 'text-success'
              : 'text-danger'}"
        >
          {pct ?? "-"}
        </span>
      {/each}
    </div>
  </div>
</ThemedPanel>
