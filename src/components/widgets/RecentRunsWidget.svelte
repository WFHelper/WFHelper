<script lang="ts">
  import { onMount } from "svelte";

  import { formatDuration } from "../../lib/arbi/arbiChartData.js";
  import { tr, locale } from "../../lib/i18n.js";
  import { log } from "../../lib/log.js";
  import { arbiRuns, arbiRunsLoaded, loadArbiRuns } from "../../stores/arbiRuns.js";
  import { dashboardLayout, settingNumber, widgetSettings } from "../../stores/dashboard.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  const settings = $derived(widgetSettings($dashboardLayout, "widget.recentRuns"));
  const limit = $derived(settingNumber(settings, "limit", 5));
  const rows = $derived([...$arbiRuns].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit));

  function runDate(startedAt: number): string {
    return new Date(startedAt).toLocaleDateString($locale, {
      month: "short",
      day: "numeric",
    });
  }

  // The run index is the store's own one-shot read, shared with the Arbitrations
  // tab; without it the widget stays blank until that tab is opened once.
  onMount(() => {
    if (!$arbiRunsLoaded) {
      void loadArbiRuns().catch((error: unknown) => {
        log.warn("[Dashboard] arbitration run load failed:", error);
      });
    }
  });
</script>

<WidgetFrame
  widgetId="widget.recentRuns"
  empty={rows.length === 0}
  emptyKey={$arbiRunsLoaded ? "arbi.empty" : "common.loading"}
>
  {#snippet subtitle()}
    <p class="m-0 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted" data-widget-status>
      {$tr("arbi.runCount", { count: String($arbiRuns.length) })}
    </p>
  {/snippet}
  <!-- Rows are a grid rather than a table: `<tr>` collides with the `tr` store
       this file imports, which Svelte warns about on every occurrence. -->
  <div class="flex max-h-[340px] flex-1 flex-col overflow-y-auto">
    <div
      class="grid grid-cols-[auto_1fr_auto_auto_auto] items-baseline gap-x-3 py-1 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted"
    >
      <span>{$tr("arbi.col.date")}</span>
      <span>{$tr("common.node")}</span>
      <span>{$tr("common.duration")}</span>
      <span class="text-right">{$tr("arbi.col.rotations")}</span>
      <span class="text-right">{$tr("arbi.col.vitus")}</span>
    </div>
    {#each rows as run (run.id)}
      <div
        class="grid grid-cols-[auto_1fr_auto_auto_auto] items-baseline gap-x-3 py-1 text-sm text-text-secondary"
        data-widget-run={run.id}
      >
        <span class="shrink-0 whitespace-nowrap tabular-nums">{runDate(run.startedAt)}</span>
        <span class="min-w-0 truncate">{run.node || run.missionName}</span>
        <span class="shrink-0 whitespace-nowrap tabular-nums">
          {formatDuration(run.durationSec)}
        </span>
        <span class="shrink-0 text-right tabular-nums">{run.rotations}</span>
        <span class="shrink-0 text-right tabular-nums text-text-primary"
          >{run.vitusActual ?? "-"}</span
        >
      </div>
    {/each}
  </div>
</WidgetFrame>
