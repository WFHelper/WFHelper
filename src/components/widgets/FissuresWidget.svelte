<script lang="ts">
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import { buildFissureRows } from "../../lib/world/useWorldView.js";
  import { dashboardLayout, settingNumber, widgetSettings } from "../../stores/dashboard.js";
  import { worldData, worldFissureMode } from "../../stores/world.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  interface Props {
    nowMs: number;
    nowCoarseMs: number;
  }

  const { nowMs, nowCoarseMs }: Props = $props();

  const MODE_LABEL_KEYS: Record<string, MessageKey> = {
    all: "common.all",
    normal: "common.normal",
    steel: "common.steelPath",
    railjack: "world.railjack",
  };

  const wd = $derived($worldData);
  const settings = $derived(widgetSettings($dashboardLayout, "widget.fissures"));
  const limit = $derived(settingNumber(settings, "limit", 5));
  // The World tab's own mode filter, so the two lists agree on what counts.
  const rows = $derived(buildFissureRows(wd?.fissures, $worldFissureMode, nowMs, nowCoarseMs));
  const shown = $derived(rows.slice(0, limit));
  const modeKey = $derived(MODE_LABEL_KEYS[$worldFissureMode] ?? "common.all");
</script>

<WidgetFrame
  widgetId="widget.fissures"
  empty={shown.length === 0}
  emptyKey={wd ? "world.noFissuresAny" : "world.unavailable"}
>
  <p class="m-0 text-[11px] uppercase tracking-wide text-text-muted">{$tr(modeKey)}</p>
  <ul class="m-0 flex list-none flex-col gap-1 p-0 text-xs">
    {#each shown as fissure (`${fissure.node}|${fissure.tier}|${fissure.expiry}`)}
      <li class="flex items-baseline gap-2">
        <span
          class="w-12 shrink-0 rounded-[var(--radius-sm)] text-center font-bold"
          class:world-badge-lith={fissure.tierCls === "lith"}
          class:world-badge-meso={fissure.tierCls === "meso"}
          class:world-badge-neo={fissure.tierCls === "neo"}
          class:world-badge-axi={fissure.tierCls === "axi"}
          class:world-badge-requiem={fissure.tierCls === "requiem"}>{fissure.tier}</span
        >
        <span class="min-w-0 flex-1 truncate text-text-secondary">
          {fissure.missionType} &middot; {fissure.node}
        </span>
        <span class="shrink-0 font-display tracking-[0.02em] text-text-primary"
          >{fissure.timeStr}</span
        >
      </li>
    {/each}
  </ul>
  {#if rows.length > shown.length}
    <!-- "+N more" is generic; the key it lives under is the planner's only by history. -->
    <p class="m-0 text-right text-[11px] text-text-muted" data-widget-more>
      {$tr("mastery.planner.moreMaterials", { count: String(rows.length - shown.length) })}
    </p>
  {/if}
</WidgetFrame>
