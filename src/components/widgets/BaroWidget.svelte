<script lang="ts">
  import { activeWindow } from "../../lib/format.js";
  import { tr } from "../../lib/i18n.js";
  import { buildWorldTimes } from "../../lib/world/useWorldView.js";
  import { worldData } from "../../stores/world.js";
  import WidgetFrame from "./WidgetFrame.svelte";

  interface Props {
    nowMs: number;
    nowCoarseMs: number;
  }

  const { nowMs, nowCoarseMs }: Props = $props();

  const wd = $derived($worldData);
  const baro = $derived(wd?.voidTrader ?? null);
  const baroActive = $derived(activeWindow(baro?.activation, baro?.expiry, nowCoarseMs));
  const times = $derived(
    buildWorldTimes({
      baro,
      baroActive,
      varzia: wd?.vaultTrader ?? null,
      varziaActive: false,
      sortie: wd?.sortie,
      steelPath: wd?.steelPath,
      duviri: wd?.duviriCycle,
      earth: wd?.earthCycle ?? {},
      cetus: wd?.cetusCycle ?? {},
      vallis: wd?.vallisCycle ?? {},
      cambion: wd?.cambionCycle ?? {},
      nowMs,
    }),
  );
  const manifest = $derived(baroActive ? (baro?.inventory ?? []) : []);
  const shown = $derived(manifest.slice(0, 4));
</script>

<WidgetFrame
  widgetId="widget.baro"
  empty={!baro?.activation && !baro?.expiry}
  emptyKey={wd ? "world.noData" : "world.unavailable"}
>
  <p class="m-0 text-sm text-text-primary">
    {baroActive
      ? $tr("world.baroLeavesIn", { baro: times.baro })
      : $tr("world.baroArrivesIn", { baro: times.baro })}
  </p>
  {#if baro?.location}
    <p class="m-0 text-xs text-text-secondary">{baro.location}</p>
  {/if}
  {#if shown.length > 0}
    <ul class="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {#each shown as entry (entry.uniqueName ?? entry.item)}
        <li class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate text-text-secondary">{entry.item}</span>
          {#if entry.ducats}
            <span class="shrink-0 text-text-muted"
              >{$tr("world.baro.ducatsShort", { count: String(entry.ducats) })}</span
            >
          {/if}
          {#if entry.credits}
            <span class="shrink-0 text-text-muted"
              >{$tr("world.baro.creditsShort", { amount: String(entry.credits) })}</span
            >
          {/if}
        </li>
      {/each}
    </ul>
    {#if manifest.length > shown.length}
      <p class="m-0 text-right text-[11px] text-text-muted" data-widget-more>
        {$tr("mastery.planner.moreMaterials", { count: String(manifest.length - shown.length) })}
      </p>
    {/if}
  {/if}
</WidgetFrame>
