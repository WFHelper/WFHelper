<script lang="ts">
  import { tr } from "../../lib/i18n.js";
  import type { MessageKey } from "../../lib/i18n.js";
  import ThemedPanel from "../ThemedPanel.svelte";
  import type { ArbiRunStats } from "../../types/ipc.js";
  import { computeCadence } from "../../lib/arbi/arbiCadence.js";
  import type { ArbiSegment, ArbiSegmentKind } from "../../lib/arbi/arbiCadence.js";
  import { formatDuration } from "../../lib/arbi/arbiChartData.js";

  const { stats }: { stats: ArbiRunStats } = $props();

  const cadence = $derived(computeCadence(stats));

  const SEGMENT_COLOR: Record<ArbiSegmentKind, string> = {
    active: "var(--success)",
    dry: "var(--warning)",
    reward: "var(--info)",
    gap: "var(--text-muted)",
  };
  const LEGEND: ArbiSegmentKind[] = ["active", "dry", "reward", "gap"];

  const KIND_KEYS: Record<ArbiSegmentKind, MessageKey> = {
    active: "arbi.cadence.kind.active",
    dry: "arbi.cadence.kind.dry",
    reward: "arbi.cadence.kind.reward",
    gap: "arbi.cadence.kind.gap",
  };

  /** The translator is passed in so the title follows a language switch. */
  function segmentTitle(t: typeof $tr, segment: ArbiSegment, startSec: number): string {
    const at = t("arbi.cadence.atTime", { time: formatDuration(segment.start - startSec) });
    const span = formatDuration(segment.end - segment.start);
    const drones = t("arbi.cadence.dronesCount", { count: String(segment.drones) });
    return `${t(KIND_KEYS[segment.kind])} · ${span} · ${at} · ${drones}`;
  }
</script>

{#if cadence}
  <ThemedPanel className="flex flex-col p-5">
    <h3 class="m-0 text-sm font-semibold uppercase tracking-wide text-text-secondary">
      {$tr("arbi.cadence.title")}
    </h3>
    <p class="mb-3 mt-1 text-xs text-text-muted">{$tr("arbi.cadence.desc")}</p>

    <div
      class="flex h-6 w-full overflow-hidden rounded-sm border border-border bg-bg-raised"
      data-arbi-timeline
    >
      {#each cadence.segments as segment (segment.start)}
        <div
          class="h-full min-w-[2px]"
          style="flex:{Math.max(
            segment.end - segment.start,
            0.001,
          )} 1 0; background-color:{SEGMENT_COLOR[segment.kind]}"
          title={segmentTitle($tr, segment, cadence.startSec)}
        ></div>
      {/each}
    </div>

    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
      {#each LEGEND as kind (kind)}
        <span class="inline-flex items-center gap-1.5">
          <span
            class="inline-block h-2 w-2 rounded-full"
            style="background-color:{SEGMENT_COLOR[kind]}"
          ></span>
          {$tr(KIND_KEYS[kind])}
        </span>
      {/each}
    </div>

    <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-4">
      <div class="flex flex-col gap-0.5">
        <dt class="text-xs uppercase tracking-wide text-text-muted">
          {$tr("arbi.cadence.longestDry")}
        </dt>
        <dd class="m-0 font-bold text-text-primary">
          {cadence.longestDry
            ? formatDuration(cadence.longestDry.end - cadence.longestDry.start)
            : "–"}
        </dd>
        {#if cadence.longestDry}
          <span class="text-xs text-text-muted">
            {$tr("arbi.cadence.atTime", {
              time: formatDuration(cadence.longestDry.start - cadence.startSec),
            })}
          </span>
        {/if}
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-xs uppercase tracking-wide text-text-muted">
          {$tr("arbi.cadence.drySpells")}
        </dt>
        <dd class="m-0 font-bold text-text-primary">{cadence.drySpellCount}</dd>
        <span class="text-xs text-text-muted">
          {$tr("arbi.cadence.threshold", { sec: cadence.dryThresholdSec.toFixed(0) })}
        </span>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-xs uppercase tracking-wide text-text-muted">
          {$tr("arbi.cadence.busiestMinute")}
        </dt>
        <dd class="m-0 font-bold text-text-primary">
          {cadence.busiestMinute ? cadence.busiestMinute.drones : "–"}
        </dd>
        {#if cadence.busiestMinute}
          <span class="text-xs text-text-muted">
            {$tr("arbi.cadence.atTime", {
              time: formatDuration(cadence.busiestMinute.start - cadence.startSec),
            })}
          </span>
        {/if}
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-xs uppercase tracking-wide text-text-muted">
          {$tr("arbi.cadence.activeShare")}
        </dt>
        <dd class="m-0 font-bold text-text-primary">{(cadence.activeShare * 100).toFixed(1)}%</dd>
      </div>
    </dl>
  </ThemedPanel>
{/if}
