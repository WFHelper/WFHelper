<script lang="ts">
  import { tr, type MessageKey } from "../../lib/i18n.js";
  import { withRowKeys } from "../../lib/widgets/rows.js";
  import { buildFissureRows } from "../../lib/world/useWorldView.js";
  import {
    dashboardLayout,
    settingBoolean,
    settingNumber,
    widgetSettings,
  } from "../../stores/dashboard.js";
  import { worldData, worldFissureMode, worldLoading } from "../../stores/world.js";
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
  const modeRows = $derived(buildFissureRows(wd?.fissures, $worldFissureMode, nowMs, nowCoarseMs));
  const rows = $derived(modeRows.filter((row) => settingBoolean(settings, row.tierCls, true)));
  const shown = $derived(
    withRowKeys(rows.slice(0, limit), (row) => `${row.node}|${row.tier}|${row.expiry}`),
  );
  const modeKey = $derived(MODE_LABEL_KEYS[$worldFissureMode] ?? "common.all");
</script>

<WidgetFrame
  widgetId="widget.fissures"
  loading={$worldLoading && !wd}
  empty={shown.length === 0}
  emptyKey={wd ? "world.noFissuresAny" : "world.unavailable"}
  overflow={rows.length - shown.length}
>
  {#snippet subtitle()}
    <p class="m-0 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted" data-widget-status>
      {$tr(modeKey)}
    </p>
  {/snippet}
  <ul class="m-0 max-h-[340px] flex-1 list-none overflow-y-auto p-0">
    {#each shown as fissure (fissure.rowKey)}
      <li class="flex items-baseline gap-2 py-1 text-sm" data-fissure-tier={fissure.tierCls}>
        <span
          class="w-12 shrink-0 rounded-[var(--radius-sm)] text-center text-xs font-bold"
          class:world-badge-lith={fissure.tierCls === "lith"}
          class:world-badge-meso={fissure.tierCls === "meso"}
          class:world-badge-neo={fissure.tierCls === "neo"}
          class:world-badge-axi={fissure.tierCls === "axi"}
          class:world-badge-requiem={fissure.tierCls === "requiem"}
          class:world-badge-omnia={fissure.tierCls === "omnia"}>{fissure.tier}</span
        >
        <span class="min-w-0 flex-1 truncate text-text-secondary">
          {fissure.missionType} &middot; {fissure.node}
        </span>
        <span class="shrink-0 font-display tabular-nums text-text-primary">{fissure.timeStr}</span>
      </li>
    {/each}
  </ul>
</WidgetFrame>
