<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import { dpmSeries } from "../../lib/arbi/arbiChartData.js";

  export let stats: ArbiRunStats;

  const W = 440;
  const H = 230;
  const MARGIN = { top: 16, right: 14, bottom: 24, left: 36 };
  const GRAPH_W = W - MARGIN.left - MARGIN.right;
  const GRAPH_H = H - MARGIN.top - MARGIN.bottom;

  let tooltip: { text: string; x: number; y: number } | null = null;

  $: series = dpmSeries(stats);
  $: minVal = series.length ? Math.floor(Math.min(...series)) : 0;
  $: maxVal = series.length ? Math.ceil(Math.max(...series)) : 1;
  $: range = maxVal - minVal || 1;
  $: avg = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0;
  $: avgY = GRAPH_H - ((avg - minVal) / range) * GRAPH_H;

  $: points = series.map((val, i) => ({
    x: series.length > 1 ? (i / (series.length - 1)) * GRAPH_W : GRAPH_W / 2,
    y: GRAPH_H - ((val - minVal) / range) * GRAPH_H,
    val,
    rotation: i + 1,
  }));
  $: pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" ");

  $: yStep = ((): number => {
    if (range >= 20) return 5;
    if (range >= 8) return 2;
    return 1;
  })();
  $: yTicks = ((): number[] => {
    const ticks: number[] = [];
    for (let v = minVal; v <= maxVal; v += yStep) ticks.push(v);
    return ticks;
  })();
  $: xLabelStride = series.length > 12 ? Math.ceil(series.length / 12) : 1;

  function showTooltip(e: MouseEvent, p: { val: number; rotation: number }): void {
    tooltip = {
      text: `${$tr("arbi.rotations.round", { n: String(p.rotation) })}: ${p.val.toFixed(1)} DPM`,
      x: e.clientX,
      y: e.clientY,
    };
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

<ThemedPanel className="flex flex-col p-5">
  <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
    {$tr("arbi.dpm.title")}
  </h3>
  <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.dpm.desc")}</p>

  {#if series.length > 1}
    <svg viewBox="0 0 {W} {H}" class="block w-full font-mono text-[10px]" aria-hidden="true">
      <g transform="translate({MARGIN.left}, {MARGIN.top})">
        {#each yTicks as tick}
          {@const y = GRAPH_H - ((tick - minVal) / range) * GRAPH_H}
          <line x1="0" y1={y} x2={GRAPH_W} y2={y} stroke="rgba(255,255,255,0.1)" stroke-width="1" />
          <text x="-6" {y} dy="3" text-anchor="end" fill="var(--text-muted, #888)">{tick}</text>
        {/each}
        <path
          d={pathD}
          fill="none"
          stroke="var(--accent)"
          stroke-width="2"
          stroke-linejoin="round"
        />
        <line
          x1="0"
          y1={avgY}
          x2={GRAPH_W}
          y2={avgY}
          stroke="currentColor"
          stroke-width="1"
          stroke-dasharray="4"
          opacity="0.8"
          class="text-text-primary"
        />
        <text
          x={GRAPH_W}
          y={avgY - 6}
          text-anchor="end"
          fill="currentColor"
          class="text-text-primary"
          font-size="11">AVG: {avg.toFixed(1)}</text
        >
        {#each points as p, i (p.rotation)}
          <circle cx={p.x} cy={p.y} r="2.5" fill="var(--accent)" />
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <circle
            cx={p.x}
            cy={p.y}
            r="8"
            fill="transparent"
            style="cursor:pointer"
            on:mouseenter={(e) => showTooltip(e, p)}
            on:mouseleave={() => (tooltip = null)}
          />
          {#if i === 0 || i === points.length - 1 || (i + 1) % xLabelStride === 0}
            <text
              x={p.x}
              y={GRAPH_H + 15}
              text-anchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
              fill="var(--text-muted, #888)">{p.rotation}</text
            >
          {/if}
        {/each}
      </g>
    </svg>
  {:else}
    <p class="py-4 text-center text-sm text-text-muted">–</p>
  {/if}
</ThemedPanel>
