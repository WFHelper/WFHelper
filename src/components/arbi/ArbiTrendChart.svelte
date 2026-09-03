<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunRecord } from "../../types/ipc.js";
  import { formatRunDate } from "../../lib/arbi/arbiChartData.js";
  import {
    ARBI_CONSISTENCY_WINDOW,
    arbiTrendSeries,
    rollingConsistency,
  } from "../../lib/arbi/arbiTrends.js";
  import type { ArbiTrendGroup, ArbiTrendMetric } from "../../lib/arbi/arbiTrends.js";

  const { runs }: { runs: ArbiRunRecord[] } = $props();

  const W = 640;
  const H = 240;
  const MARGIN = { top: 14, right: 14, bottom: 26, left: 44 };
  const GRAPH_W = W - MARGIN.left - MARGIN.right;
  const GRAPH_H = H - MARGIN.top - MARGIN.bottom;
  /** Beyond this the lines stop being readable and the colours repeat. */
  const MAX_SERIES = 6;
  const SERIES_COLORS = [
    "var(--accent)",
    "var(--info)",
    "var(--success)",
    "var(--warning)",
    "var(--danger)",
    "var(--text-secondary)",
  ];

  let metric = $state<ArbiTrendMetric>("dronesPerMin");
  let group = $state<ArbiTrendGroup>("none");
  let tooltip = $state<{ text: string; x: number; y: number } | null>(null);

  const METRICS: ArbiTrendMetric[] = ["dronesPerMin", "expectedVitusPerMin"];
  const GROUPS: ArbiTrendGroup[] = ["none", "node", "missionType"];

  const allSeries = $derived(arbiTrendSeries(runs, metric, group));
  const series = $derived(allSeries.slice(0, MAX_SERIES));
  const points = $derived(series.flatMap((s) => s.points));
  const minX = $derived(points.length ? Math.min(...points.map((p) => p.startedAt)) : 0);
  const maxX = $derived(points.length ? Math.max(...points.map((p) => p.startedAt)) : 1);
  const maxY = $derived(points.length ? Math.max(...points.map((p) => p.value)) : 1);
  const yTicks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY));

  function px(startedAt: number): number {
    const span = maxX - minX;
    return span > 0 ? ((startedAt - minX) / span) * GRAPH_W : GRAPH_W / 2;
  }

  function py(value: number): number {
    return maxY > 0 ? GRAPH_H - (value / maxY) * GRAPH_H : GRAPH_H;
  }

  function metricKey(value: ArbiTrendMetric): MessageKey {
    return `arbi.metric.${value}` as MessageKey;
  }

  function groupKey(value: ArbiTrendGroup): MessageKey {
    if (value === "node") return "common.node";
    if (value === "missionType") return "common.type";
    return "arbi.trend.group.none";
  }

  /** Series keys are game data (node names) except mission types, which translate. */
  function seriesLabel(t: typeof $tr, key: string): string {
    if (group === "missionType") return t(`arbi.type.${key}` as MessageKey);
    return key || t("arbi.trend.group.none");
  }

  function showTooltip(event: MouseEvent, text: string): void {
    tooltip = { text, x: event.clientX, y: event.clientY };
  }
</script>

{#if tooltip}
  <div
    class="pointer-events-none fixed z-[500] whitespace-nowrap rounded-[var(--radius-sm)] border border-border-strong bg-bg-raised px-2.5 py-1 text-xs text-text-primary shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
    style="left:{tooltip.x + 14}px; top:{tooltip.y - 34}px"
    aria-hidden="true"
  >
    {tooltip.text}
  </div>
{/if}

<!-- The marker sits on the wrapper, not the plot: with fewer than two runs the
     panel still renders but the svg does not. -->
<div data-arbi-trend>
  <ThemedPanel className="flex flex-col p-5">
    <div class="flex flex-wrap items-center gap-3">
      <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
        {$tr("arbi.trend.title")}
      </h3>
      <label class="flex items-center gap-1.5 text-xs">
        <span class="uppercase tracking-wide text-text-muted">{$tr("common.stats")}</span>
        <select
          class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
          bind:value={metric}
        >
          {#each METRICS as option (option)}
            <option value={option}>{$tr(metricKey(option))}</option>
          {/each}
        </select>
      </label>
      <label class="flex items-center gap-1.5 text-xs">
        <span class="uppercase tracking-wide text-text-muted">{$tr("common.category")}</span>
        <select
          class="rounded border border-border bg-bg-raised px-2 py-1 text-text-primary outline-none focus:border-accent"
          bind:value={group}
        >
          {#each GROUPS as option (option)}
            <option value={option}>{$tr(groupKey(option))}</option>
          {/each}
        </select>
      </label>
    </div>
    <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.trend.desc")}</p>

    {#if points.length > 1}
      <svg
        viewBox="0 0 {W} {H}"
        class="block w-full font-mono text-[10px]"
        data-arbi-trend-plot
        aria-hidden="true"
      >
        <g transform="translate({MARGIN.left}, {MARGIN.top})">
          {#each yTicks as tick (tick)}
            <line
              x1="0"
              y1={py(tick)}
              x2={GRAPH_W}
              y2={py(tick)}
              stroke="currentColor"
              stroke-width="1"
              opacity="0.12"
              class="text-text-primary"
            />
            <text
              x="-6"
              y={py(tick)}
              dy="3"
              text-anchor="end"
              fill="currentColor"
              class="text-text-muted">{tick.toFixed(1)}</text
            >
          {/each}
          {#each series as line, index (line.key)}
            {@const color = SERIES_COLORS[index % SERIES_COLORS.length]}
            <path
              d={line.points
                .map((p, i) => `${i === 0 ? "M" : "L"} ${px(p.startedAt)},${py(p.value)}`)
                .join(" ")}
              fill="none"
              stroke={color}
              stroke-width="2"
              stroke-linejoin="round"
            />
            {#each line.points as point (point.id)}
              <circle cx={px(point.startedAt)} cy={py(point.value)} r="2.5" fill={color} />
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <circle
                cx={px(point.startedAt)}
                cy={py(point.value)}
                r="8"
                fill="transparent"
                style="cursor:pointer"
                onmouseenter={(event) =>
                  showTooltip(
                    event,
                    `${formatRunDate(point.startedAt)}: ${point.value.toFixed(2)}`,
                  )}
                onmouseleave={() => (tooltip = null)}
              ></circle>
            {/each}
          {/each}
        </g>
      </svg>

      <div class="mt-2 flex flex-col gap-1 text-xs">
        <span class="text-text-muted" title={$tr("arbi.trend.consistencyDesc")}>
          {$tr("arbi.trend.consistency", { count: String(ARBI_CONSISTENCY_WINDOW) })}
        </span>
        {#each series as line, index (line.key)}
          {@const cv = rollingConsistency(line.points)}
          <span class="flex items-center gap-2">
            <span
              class="inline-block h-2 w-2 shrink-0 rounded-full"
              style="background-color:{SERIES_COLORS[index % SERIES_COLORS.length]}"
            ></span>
            <span class="text-text-secondary">{seriesLabel($tr, line.key)}</span>
            <span class="text-text-muted">({line.points.length})</span>
            <span class="font-mono text-text-primary">
              {cv === null ? "–" : `${(cv * 100).toFixed(1)}%`}
            </span>
          </span>
        {/each}
        {#if allSeries.length > series.length}
          <span class="text-text-muted"
            >{$tr("arbi.trend.moreSeries", {
              count: String(allSeries.length - series.length),
            })}</span
          >
        {/if}
      </div>
    {:else}
      <p class="py-4 text-center text-sm text-text-muted">{$tr("arbi.trend.notEnough")}</p>
    {/if}
  </ThemedPanel>
</div>
