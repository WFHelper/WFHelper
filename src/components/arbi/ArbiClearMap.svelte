<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiMissionType, ArbiRunStats } from "../../types/ipc.js";
  import {
    ARBI_SATURATION_THRESHOLD,
    formatClock,
    median,
    relativePerformanceHue,
    rotationClearCells,
    waveClearCells,
  } from "../../lib/arbi/arbiChartData.js";

  const { stats, missionType }: { stats: ArbiRunStats; missionType: ArbiMissionType } = $props();

  /** Above this per-wave clear time the box is flagged slow (reference threshold). */
  const SLOW_WAVE_SEC = 25;
  /** Disruption rounds last minutes and vary by squad, so judge them against
   * this run's own median rather than a fixed clock. */
  const SLOW_ROUND_FACTOR = 1.25;
  const FAST_ROUND_FACTOR = 0.8;

  const mode = $derived(
    missionType === "disruption" ? "round" : missionType === "defense" ? "wave" : "rotation",
  );
  const cells = $derived(mode === "rotation" ? rotationClearCells(stats) : waveClearCells(stats));

  const medianSec = $derived(mode === "round" ? median(cells.map((c) => c.durationSec)) : 0);

  const fastestSec = $derived(cells.length ? Math.min(...cells.map((c) => c.durationSec)) : 0);
  const slowestSec = $derived(cells.length ? Math.max(...cells.map((c) => c.durationSec)) : 0);

  function tone(durationSec: number): string {
    if (mode === "wave") {
      return durationSec > SLOW_WAVE_SEC
        ? "border-danger/50 bg-danger/15 text-danger"
        : "border-success/50 bg-success/15 text-success";
    }
    if (mode === "round") {
      if (medianSec <= 0) return "border-border bg-surface-2 text-text-secondary";
      if (durationSec > medianSec * SLOW_ROUND_FACTOR)
        return "border-danger/50 bg-danger/15 text-danger";
      if (durationSec < medianSec * FAST_ROUND_FACTOR)
        return "border-success/50 bg-success/15 text-success";
      return "border-border bg-surface-2 text-text-secondary";
    }
    return "border-border bg-bg-raised";
  }

  /** Rotation cells are judged against this run only: fastest green, slowest red.
   * With a single rotation there is nothing slower, so it is not painted red. */
  function relativeColor(durationSec: number): string {
    const hue =
      slowestSec === fastestSec
        ? 120
        : relativePerformanceHue(slowestSec - durationSec, 0, slowestSec - fastestSec);
    return `hsl(${hue}, 100%, 50%)`;
  }

  function titleKey(): MessageKey {
    if (mode === "wave") return "arbi.waveMap.title";
    if (mode === "round") return "arbi.roundMap.title";
    return "arbi.clearMap.rotation.title";
  }

  function descKey(): MessageKey {
    if (mode === "wave") return "arbi.waveMap.desc";
    if (mode === "round") return "arbi.roundMap.desc";
    return "arbi.clearMap.rotation.desc";
  }
</script>

{#if cells.length > 0}
  <ThemedPanel className="flex flex-col p-5">
    <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
      {$tr(titleKey())}
    </h3>
    <p class="mb-3 mt-1 text-xs text-text-muted">{$tr(descKey())}</p>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1.5" data-arbi-clear-map>
      {#each cells as cell (cell.index)}
        <div
          class="flex h-11 flex-col items-center justify-center rounded-sm border leading-tight {tone(
            cell.durationSec,
          )}"
          style={mode === "rotation" ? `color:${relativeColor(cell.durationSec)}` : ""}
          title={cell.saturationPct === null
            ? $tr("arbi.clearMap.cellPlain", {
                index: String(cell.index),
                time: formatClock(cell.durationSec),
              })
            : $tr("arbi.clearMap.cell", {
                index: String(cell.index),
                time: formatClock(cell.durationSec),
                pct: cell.saturationPct.toFixed(0),
                count: String(ARBI_SATURATION_THRESHOLD),
              })}
        >
          <span class="font-mono text-xs font-bold">{formatClock(cell.durationSec)}</span>
          <span class="font-mono text-[10px] opacity-70">
            {cell.saturationPct === null ? "–" : `${cell.saturationPct.toFixed(0)}%`}
          </span>
        </div>
      {/each}
    </div>

    <p class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
      {#if mode === "wave"}
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2 w-2 rounded-full bg-success"></span>
          {$tr("arbi.clearMap.legend.fast", { sec: String(SLOW_WAVE_SEC) })}
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2 w-2 rounded-full bg-danger"></span>
          {$tr("arbi.clearMap.legend.slow", { sec: String(SLOW_WAVE_SEC) })}
        </span>
      {:else}
        <span>
          {$tr("arbi.clearMap.legend.range", {
            fast: formatClock(fastestSec),
            slow: formatClock(slowestSec),
          })}
        </span>
      {/if}
      <span>
        {$tr("arbi.clearMap.legend.saturation", {
          count: String(ARBI_SATURATION_THRESHOLD),
        })}
      </span>
    </p>
  </ThemedPanel>
{/if}
