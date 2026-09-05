<script lang="ts">
  import { activeWindow } from "../../lib/format.js";
  import { tr } from "../../lib/i18n.js";
  import { buildWorldTimes } from "../../lib/world/useWorldView.js";
  import { worldData, worldLoading } from "../../stores/world.js";
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
  loading={$worldLoading && !wd}
  empty={!baro?.activation && !baro?.expiry}
  emptyKey={wd ? "world.noData" : "world.unavailable"}
  overflow={manifest.length - shown.length}
>
  {#snippet subtitle()}
    {#if baro?.location}
      <p class="m-0 text-[0.68rem] uppercase tracking-[0.06em] text-text-muted" data-widget-status>
        {baro.location}
      </p>
    {/if}
  {/snippet}
  <p class="m-0 text-sm text-text-primary">
    {baroActive
      ? $tr("world.baroLeavesIn", { baro: times.baro })
      : $tr("world.baroArrivesIn", { baro: times.baro })}
  </p>
  {#if shown.length > 0}
    <ul class="m-0 max-h-[340px] flex-1 list-none overflow-y-auto p-0">
      {#each shown as entry (entry.uniqueName ?? entry.item)}
        <li class="flex items-baseline gap-2 py-1 text-sm">
          <span class="min-w-0 flex-1 truncate text-text-secondary">{entry.item}</span>
          {#if entry.ducats}
            <span class="shrink-0 tabular-nums text-text-muted"
              >{$tr("world.baro.ducatsShort", { count: String(entry.ducats) })}</span
            >
          {/if}
          {#if entry.credits}
            <span class="shrink-0 tabular-nums text-text-muted"
              >{$tr("world.baro.creditsShort", { amount: String(entry.credits) })}</span
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</WidgetFrame>
